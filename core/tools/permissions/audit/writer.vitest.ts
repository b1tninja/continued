import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decisionDraft,
  errorSignature,
  outcomeDraft,
  turnDraft,
  type DecisionEvent,
  type OutcomeEvent,
} from "./record";
import { AuditWriter, readAuditFile, safeSessionName } from "./writer";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixed = (iso: string) => () => new Date(iso);
const T0 = "2026-11-10T12:00:00.000Z";

function decision(over: Partial<Parameters<typeof decisionDraft>[0]> = {}) {
  return decisionDraft({
    session: "s1",
    turn: 1,
    callId: "c1",
    tool: "run_terminal_command",
    args: JSON.stringify({ command: "npm test" }),
    policy: "allow",
    by: "rules",
    source: "allow-rule",
    rule: "Bash(npm test)",
    reason: "Allowed by your rule.",
    ...over,
  });
}

describe("records", () => {
  it("masks the arguments and hashes the masked text", () => {
    const d = decision({
      args: JSON.stringify({ command: "API_TOKEN=abcd1234 curl x" }),
    }) as Omit<DecisionEvent, "v" | "seq" | "ts">;
    expect(d.argsMasked).not.toContain("abcd1234");
    expect(d.maskedKinds).toEqual(["secret-variable"]);
    expect(d.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("masks and clips the reason and the display value", () => {
    const d = decision({
      reason: `because TOKEN_Z=secretvalue99 ${"x".repeat(500)}`,
      displayValue: "PASSWORD=hunter2hunter2 run",
    }) as Omit<DecisionEvent, "v" | "seq" | "ts">;
    expect(d.reason).not.toContain("secretvalue99");
    expect(d.reason!.length).toBeLessThan(330);
    expect(d.displayValue).not.toContain("hunter2hunter2");
  });

  it("leaves out fields that were not given", () => {
    const d = decision();
    expect("answers" in d).toBe(false);
    expect("reviewer" in d).toBe(false);
  });

  it("writes an error signature that is stable across numbers and masked", () => {
    expect(
      errorSignature("\n  Error at line 42: port 8080 in use 0xdeadbeef01"),
    ).toBe("Error at line #: port # in use #");
    expect(errorSignature("failed TOKEN_X=sekrit123 more")).not.toContain(
      "sekrit123",
    );
    expect(errorSignature("x".repeat(500)).length).toBeLessThanOrEqual(210);
  });
});

describe("AuditWriter", () => {
  it("appends one JSON line per record under <dir>/<yyyy-mm>/<session>.jsonl", () => {
    const w = new AuditWriter({ dir, now: fixed(T0) });
    const r1 = w.write(decision());
    const r2 = w.write(
      outcomeDraft({
        session: "s1",
        turn: 1,
        callId: "c1",
        tool: "run_terminal_command",
        ran: true,
        exit: 1,
        durMs: 1200,
        outBytes: 300,
        error: "FAIL src/a.test.ts took 123ms",
        changed: ["src/a.ts"],
        read: ["src/b.ts"],
      }),
    );
    const w3 = w.write(
      turnDraft({ session: "s1", turn: 1, textChars: 40, calls: 1 }),
    );
    expect([r1.ok, r2.ok, w3.ok]).toEqual([true, true, true]);
    const file = path.join(dir, "2026-11", "s1.jsonl");
    expect(fs.existsSync(file)).toBe(true);

    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const recs = readAuditFile(file);
    expect(recs.map((r) => [r.ev, r.seq, r.v])).toEqual([
      ["decision", 1, 1],
      ["outcome", 2, 1],
      ["turn", 3, 1],
    ]);
    expect(recs[0].ts).toBe(T0);
    const out = recs[1] as OutcomeEvent;
    expect(out.errSig).toBe("FAIL src/a.test.ts took #ms");
    expect(out.changed).toEqual(["src/a.ts"]);
    expect(Object.keys(JSON.parse(lines[0])).slice(0, 5)).toEqual([
      "v",
      "ev",
      "ts",
      "session",
      "seq",
    ]);
  });

  it("masks again on the way out, even if the caller did not", () => {
    const w = new AuditWriter({ dir, now: fixed(T0) });
    const raw = decision() as any;
    raw.argsMasked = "curl -H 'Authorization: Bearer rawleak999'";
    raw.reviewer = { model: "m", category: "PASSWORD=rawleak888" };
    w.write(raw);
    const text = fs.readFileSync(path.join(dir, "2026-11", "s1.jsonl"), "utf8");
    expect(text).not.toContain("rawleak999");
    expect(text).not.toContain("rawleak888");
  });

  it("keeps sessions in separate files and months in separate folders", () => {
    let now = new Date(T0);
    const w = new AuditWriter({ dir, now: () => now });
    w.write(decision({ session: "a" }));
    w.write(decision({ session: "b" }));
    now = new Date("2026-12-01T00:00:00Z");
    w.write(decision({ session: "a" }));
    expect(fs.readdirSync(path.join(dir, "2026-11")).sort()).toEqual([
      "a.jsonl",
      "b.jsonl",
    ]);
    expect(fs.readdirSync(path.join(dir, "2026-12"))).toEqual(["a.jsonl"]);
    // seq keeps counting for the session across the month
    expect(readAuditFile(path.join(dir, "2026-12", "a.jsonl"))[0].seq).toBe(2);
  });

  it("cannot be steered out of its directory by a session id", () => {
    const w = new AuditWriter({ dir, now: fixed(T0) });
    const r = w.write(decision({ session: "../../evil/x" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(path.dirname(path.dirname(r.file))).toBe(dir);
    expect(safeSessionName("..")).toBe("_");
    expect(safeSessionName("a/b\\c")).toBe("a_b_c");
    expect(safeSessionName("")).toBe("_");
  });

  it("rotates by size into numbered files and keeps seq counting", () => {
    const w = new AuditWriter({ dir, now: fixed(T0), maxFileBytes: 700 });
    for (let i = 0; i < 6; i++) w.write(decision({ callId: `c${i}` }));
    const files = fs.readdirSync(path.join(dir, "2026-11")).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files[0]).toBe("s1.1.jsonl");
    const all = files
      .flatMap((f) => readAuditFile(path.join(dir, "2026-11", f)))
      .map((r) => r.seq)
      .sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5, 6]);
    for (const f of files) {
      expect(
        fs.statSync(path.join(dir, "2026-11", f)).size,
      ).toBeLessThanOrEqual(700);
    }
  });

  it("a new writer resumes seq and the newest file", () => {
    new AuditWriter({ dir, now: fixed(T0), maxFileBytes: 700 }).write(
      decision(),
    );
    const w1 = new AuditWriter({ dir, now: fixed(T0), maxFileBytes: 700 });
    for (let i = 0; i < 5; i++) w1.write(decision({ callId: `x${i}` }));
    const w2 = new AuditWriter({ dir, now: fixed(T0), maxFileBytes: 700 });
    const r = w2.write(decision({ callId: "later" }));
    expect(r.ok && r.seq).toBe(7);
  });

  it("closes a line a crash cut short, and the reader skips it", () => {
    const w = new AuditWriter({ dir, now: fixed(T0) });
    w.write(decision());
    const file = path.join(dir, "2026-11", "s1.jsonl");
    fs.appendFileSync(file, '{"v":1,"ev":"decision","seq":2,"tool":"ru');
    expect(readAuditFile(file)).toHaveLength(1);

    const w2 = new AuditWriter({ dir, now: fixed(T0) });
    const r = w2.write(decision({ callId: "after" }));
    expect(r.ok && r.seq).toBe(2);
    const recs = readAuditFile(file);
    expect(recs.map((x) => x.seq)).toEqual([1, 2]);
    expect(
      fs.readFileSync(file, "utf8").split("\n").filter(Boolean),
    ).toHaveLength(3);
  });

  it("returns the failure instead of throwing", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const w = new AuditWriter({
      dir: path.join(blocker, "sub"),
      now: fixed(T0),
    });
    const r = w.write(decision());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("only the file this writer made exists, nothing is rewritten", () => {
    const w = new AuditWriter({ dir, now: fixed(T0) });
    w.write(decision());
    const file = path.join(dir, "2026-11", "s1.jsonl");
    const first = fs.readFileSync(file, "utf8");
    w.write(decision({ callId: "c2" }));
    expect(fs.readFileSync(file, "utf8").startsWith(first)).toBe(true);
  });
});
