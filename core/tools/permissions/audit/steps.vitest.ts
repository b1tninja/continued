import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectStuck,
  type StuckCall,
  type StuckStep,
} from "../../../util/stuckSignals";
import { buildWorkLog } from "../../../util/workLog";
import { decisionDraft, outcomeDraft, turnDraft } from "./record";
import { auditToAgentSteps, auditToSteps, detectStuckByAgent } from "./steps";
import { AuditWriter, readAuditFile } from "./writer";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-steps-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a history the way a host would, and read it back from the file. */
function throughAudit(steps: StuckStep[]) {
  const w = new AuditWriter({
    dir,
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  let n = 0;
  steps.forEach((s, i) => {
    const turn = i + 1;
    for (const c of s.calls) {
      const callId = `c${++n}`;
      w.write(
        decisionDraft({
          session: "s",
          turn,
          callId,
          tool: c.tool,
          args: JSON.stringify(c.args ?? {}),
          policy: "allow",
          by: "rules",
        }),
      );
      w.write(
        outcomeDraft({
          session: "s",
          turn,
          callId,
          tool: c.tool,
          ran: true,
          exit: c.error ? 1 : 0,
          output: c.result ?? "",
          error: c.error ? (c.result ?? "error") : undefined,
          changed: c.changed,
          read: c.read,
        }),
      );
    }
    w.write(
      turnDraft({
        session: "s",
        turn,
        textChars: (s.text ?? "").length,
        calls: s.calls.length,
      }),
    );
  });
  return readAuditFile(path.join(dir, "2026-11", "s.jsonl"));
}

const call = (
  tool: string,
  args: Record<string, unknown> = {},
  more: Partial<StuckCall> = {},
): StuckCall => ({ tool, args, ...more });
const bash = (command: string, result = "ok", error = false) =>
  call("Bash", { command }, { result, error });
const read = (p: string) =>
  call("Read", { path: p }, { result: `content of ${p}`, read: [p] });
const edit = (p: string, hash: string) =>
  call(
    "Edit",
    { path: p },
    { result: "edited", changed: [{ path: p, hash }], read: [p] },
  );
const step = (...calls: StuckCall[]): StuckStep => ({ calls });

const FAIL = "FAIL: 3 tests failed";

const HISTORIES: Record<string, StuckStep[]> = {
  "the same read four times": [
    step(read("a.ts")),
    step(read("a.ts")),
    step(read("a.ts")),
    step(read("a.ts")),
  ],
  "the same failing test four times": [
    step(bash("npm test", FAIL, true)),
    step(bash("npm test", FAIL, true)),
    step(bash("npm test", FAIL, true)),
    step(bash("npm test", FAIL, true)),
  ],
  "varied commands, one error": [
    step(bash("npm test -- a", "Error: ENOENT 'x' 12", true)),
    step(bash("npm test -- b", "Error: ENOENT 'x' 13", true)),
    step(bash("npm run test:unit", "Error: ENOENT 'x' 14", true)),
    step(bash("npx vitest", "Error: ENOENT 'x' 15", true)),
  ],
  "an edit that is reverted": [
    step(edit("a.ts", "h1")),
    step(edit("a.ts", "h2")),
    step(edit("a.ts", "h1")),
    step(edit("a.ts", "h2")),
    step(edit("a.ts", "h1")),
  ],
  "a test that fails until the fix lands": [
    step(bash("npm test", FAIL, true)),
    step(edit("a.ts", "h1")),
    step(bash("npm test", FAIL, true)),
    step(edit("a.ts", "h2")),
    step(bash("npm test", "all passed")),
  ],
  "healthy: reads then edits then a build": [
    step(read("a.ts"), read("b.ts")),
    step(edit("a.ts", "h1")),
    step(bash("npm run build")),
    step(edit("b.ts", "h2")),
    step(bash("npm run build")),
  ],
  "two files read in turn": [
    step(read("a.ts")),
    step(read("b.ts")),
    step(read("a.ts")),
    step(read("b.ts")),
    step(read("a.ts")),
    step(read("b.ts")),
  ],
};

describe("auditToSteps against the history path", () => {
  for (const [name, steps] of Object.entries(HISTORIES)) {
    it(`fires the same signals at every prefix: ${name}`, () => {
      const derived = auditToSteps(throughAudit(steps));
      expect(derived).toHaveLength(steps.length);
      for (let i = 1; i <= steps.length; i++) {
        const want = detectStuck(steps.slice(0, i));
        const got = detectStuck(derived.slice(0, i));
        expect(got.level).toBe(want.level);
        expect(got.signals.map((s) => [s.kind, s.level, s.count])).toEqual(
          want.signals.map((s) => [s.kind, s.level, s.count]),
        );
      }
    });

    it(`gives the same work log calls, changes and first reads: ${name}`, () => {
      const want = buildWorkLog(steps);
      const got = buildWorkLog(auditToSteps(throughAudit(steps)));
      expect(
        got.map((e) => [e.calls, e.changed, e.newReads, e.signals]),
      ).toEqual(want.map((e) => [e.calls, e.changed, e.newReads, e.signals]));
    });
  }

  it("the stuck histories in this set really do fire something", () => {
    const fired = Object.entries(HISTORIES)
      .filter(([n]) => !n.startsWith("healthy") && !n.includes("until"))
      .map(
        ([, s]) => detectStuck(auditToSteps(throughAudit(s))).signals.length,
      );
    expect(fired.every((n) => n > 0)).toBe(true);
  });
});

describe("auditToSteps details", () => {
  it("joins a decision to its outcome by call id, whatever order they arrive in", () => {
    const records = throughAudit([step(bash("ls"))]);
    const shuffled = [...records].reverse();
    expect(auditToSteps(shuffled)[0].calls[0]).toMatchObject({
      tool: "Bash",
      args: { command: "ls" },
    });
  });

  it("treats a call that did not run as a failed call", () => {
    const w = new AuditWriter({
      dir,
      now: () => new Date("2026-11-10T00:00:00Z"),
    });
    w.write(
      decisionDraft({
        session: "s",
        turn: 1,
        callId: "c1",
        tool: "Bash",
        args: JSON.stringify({ command: "rm -rf /" }),
        policy: "deny",
        by: "rules",
      }),
    );
    w.write(
      outcomeDraft({
        session: "s",
        turn: 1,
        callId: "c1",
        tool: "Bash",
        ran: false,
      }),
    );
    const [s] = auditToSteps(
      readAuditFile(path.join(dir, "2026-11", "s.jsonl")),
    );
    expect(s.calls[0]).toMatchObject({ error: true, result: "not run" });
  });

  it("keeps a text-only turn as a step with no calls and no text", () => {
    const steps = auditToSteps(
      throughAudit([
        step(bash("ls")),
        { text: "thinking about it", calls: [] },
      ]),
    );
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ calls: [] });
  });

  it("falls back to the masked text when the arguments were clipped", () => {
    const w = new AuditWriter({
      dir,
      now: () => new Date("2026-11-10T00:00:00Z"),
    });
    w.write(
      decisionDraft({
        session: "s",
        turn: 1,
        callId: "c1",
        tool: "Bash",
        args: JSON.stringify({ command: "x".repeat(5000) }),
        policy: "allow",
        by: "rules",
      }),
    );
    w.write(
      outcomeDraft({
        session: "s",
        turn: 1,
        callId: "c1",
        tool: "Bash",
        ran: true,
        exit: 0,
      }),
    );
    const [s] = auditToSteps(
      readAuditFile(path.join(dir, "2026-11", "s.jsonl")),
    );
    expect(Object.keys(s.calls[0].args!)).toEqual(["raw"]);
  });

  it("never carries a secret from the arguments or the output into the steps", () => {
    const [s] = auditToSteps(
      throughAudit([
        step(
          bash("API_TOKEN=abcd1234zz curl x", "Authorization: Bearer leak999"),
        ),
      ]),
    );
    expect(JSON.stringify(s)).not.toContain("abcd1234zz");
    expect(JSON.stringify(s)).not.toContain("leak999");
  });

  it("cannot reproduce the monologue signal: text is not in the audit", () => {
    const talk: StuckStep[] = [1, 2, 3, 4].map(() => ({
      text: "I will run the tests again to check the failing case",
      calls: [],
    }));
    expect(detectStuck(talk).signals.map((s) => s.kind)).toContain("monologue");
    expect(detectStuck(auditToSteps(throughAudit(talk))).signals).toEqual([]);
  });
});

describe("auditToSteps by agent", () => {
  const sub = { id: "sub-c1", kind: "subagent" as const, role: "Explore" };
  const main = { id: "main-s", kind: "main" as const };
  const worker = { id: "worker-3", kind: "loop-worker" as const };

  /** Records for calls, each as [agent, turn, call]; seq follows array order. */
  function write(
    calls: [typeof sub | typeof main | undefined, number, StuckCall][],
  ) {
    const w = new AuditWriter({
      dir,
      now: () => new Date("2026-11-10T12:00:00Z"),
    });
    calls.forEach(([agent, turn, c], i) => {
      const callId = `c${i}`;
      w.write(
        decisionDraft({
          session: "s",
          turn,
          callId,
          tool: c.tool,
          args: JSON.stringify(c.args ?? {}),
          policy: "allow",
          by: "rules",
          agent,
        }),
      );
      w.write(
        outcomeDraft({
          session: "s",
          turn,
          callId,
          tool: c.tool,
          ran: true,
          exit: c.error ? 1 : 0,
          output: c.result ?? "",
          error: c.error ? (c.result ?? "error") : undefined,
          changed: c.changed,
          read: c.read,
          agent,
        }),
      );
    });
    return readAuditFile(path.join(dir, "2026-11", "s.jsonl"));
  }

  const kinds = (r: ReturnType<typeof detectStuckByAgent>[number]) =>
    r.report.signals.map((s) => s.kind);

  it("a busy main agent does not mask a subagent repeating one call", () => {
    const records = write([
      [sub, 1, read("a.ts")],
      [main, 1, read("m1.ts")],
      [sub, 2, read("a.ts")],
      [main, 2, read("m2.ts")],
      [sub, 3, read("a.ts")],
      [main, 3, edit("m1.ts", "h1")],
      [sub, 4, read("a.ts")],
      [main, 4, bash("npm test")],
    ]);
    // read together, the main agent's edit resets the repeat count
    const merged = detectStuck([...auditToAgentSteps(records).values()].flat());
    expect(merged.signals.map((s) => s.kind)).not.toContain("repeat-call");
    const by = detectStuckByAgent(records);
    expect(by.map((r) => r.agent).sort()).toEqual(["main", "sub-c1"]);
    expect(kinds(by.find((r) => r.agent === "sub-c1")!)).toContain(
      "repeat-call",
    );
    expect(by.find((r) => r.agent === "main")!.report.level).toBe("none");
  });

  it("one agent's repeats do not accuse another that made each call once", () => {
    const records = write([
      [sub, 1, bash("npm test", FAIL, true)],
      [main, 1, bash("npm test", FAIL, true)],
      [worker as never, 1, bash("npm test", FAIL, true)],
      [sub, 2, read("b.ts")],
    ]);
    const by = detectStuckByAgent(records);
    expect(by.every((r) => r.report.level === "none")).toBe(true);
    // while read as one history the same calls repeat
    const merged = detectStuck([...auditToAgentSteps(records).values()].flat());
    expect(merged.signals.length).toBeGreaterThan(0);
  });

  it("turn numbers are each agent's own", () => {
    const records = write([
      [main, 1, read("a.ts")],
      [sub, 1, read("b.ts")],
      [main, 2, read("c.ts")],
    ]);
    const steps = auditToAgentSteps(records);
    expect(steps.get("main")).toHaveLength(2);
    expect(steps.get("sub-c1")).toHaveLength(1);
  });

  it("records with no agent, and main's own, are one main agent", () => {
    const records = write([
      [undefined, 1, read("a.ts")],
      [main, 2, read("a.ts")],
      [undefined, 3, read("a.ts")],
      [main, 4, read("a.ts")],
    ]);
    expect([...auditToAgentSteps(records).keys()]).toEqual(["main"]);
    expect(auditToSteps(records)).toHaveLength(4);
    expect(
      detectStuck(auditToSteps(records)).signals.map((s) => s.kind),
    ).toContain("repeat-call");
  });

  it("a text-only turn belongs to the agent that took it", () => {
    const w = new AuditWriter({
      dir,
      now: () => new Date("2026-11-10T12:00:00Z"),
    });
    w.write(
      turnDraft({ session: "s", turn: 1, textChars: 9, calls: 0, agent: sub }),
    );
    const steps = auditToAgentSteps(
      readAuditFile(path.join(dir, "2026-11", "s.jsonl")),
    );
    expect([...steps.keys()]).toEqual(["sub-c1"]);
  });

  it("auditToSteps gives the main agent by default and another by key", () => {
    const records = write([
      [main, 1, read("a.ts")],
      [sub, 1, read("b.ts")],
    ]);
    expect(auditToSteps(records)[0].calls[0].args).toEqual({ path: "a.ts" });
    expect(auditToSteps(records, "sub-c1")[0].calls[0].args).toEqual({
      path: "b.ts",
    });
    expect(auditToSteps(records, "nobody")).toEqual([]);
  });
});
