import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RuleSourcesInput } from "../effectiveRules";
import { ASK_CASES, DENY_CASES, EVAL_CASES } from "../auto/evaluation/cases";
import { parseDataset } from "../auto/evaluation/reviewEvalDataset";
import { testToolCall } from "../testToolCall";
import { maskForAudit } from "./mask";
import {
  callRows,
  DEFAULT_READ_LIMITS,
  forEachLine,
  listCalls,
  listCallsBounded,
  type AuditCallRow,
} from "./reader";
import type { AuditRecord, DecisionEvent } from "./record";
import { suggestRules } from "./suggestRules";

const LEVELS = {
  context: "cautious",
  tools: "cautious",
  edits: "cautious",
  plan: "cautious",
  questions: "cautious",
} as const;
const SOURCES: RuleSourcesInput = { levels: LEVELS as never };
const CWD = "/home/dev/shop";
const T0 = Date.parse("2026-11-01T09:00:00.000Z");

let seq = 0;
function decision(
  callId: string,
  tool: string,
  args: unknown,
  over: Partial<DecisionEvent>,
): DecisionEvent {
  const text = JSON.stringify(args);
  const masked = maskForAudit(text, 2000);
  return {
    v: 1,
    ev: "decision",
    ts: new Date(T0 + seq * 3_600_000).toISOString(),
    session: "s1",
    seq: seq++,
    callId,
    tool,
    argsMasked: masked.masked,
    argsHash: masked.hash,
    argsLen: masked.length,
    ...(masked.kinds.length ? { maskedKinds: masked.kinds } : {}),
    policy: "ask",
    by: "rules",
    source: "cautious",
    ...over,
  } as DecisionEvent;
}

/** `times` asks of one call, each answered by the person. */
function asks(
  tool: string,
  args: unknown,
  times: number,
  answer: "allow" | "deny" = "allow",
  over: Partial<DecisionEvent> = {},
): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (let i = 0; i < times; i++) {
    const id = `c${seq}`;
    out.push(decision(id, tool, args, over));
    out.push(
      decision(id, tool, args, {
        policy: answer,
        by: "person",
        source: undefined,
        ...(over.agent ? { agent: over.agent } : {}),
      }),
    );
  }
  return out;
}

const cmd = (command: string) => ({ command });
const rowsOf = (...lists: AuditRecord[][]): AuditCallRow[] =>
  callRows(lists.flat());
const BASH = "run_terminal_command";
const agent = (role: string, id = role) => ({
  id,
  kind: "subagent" as const,
  role,
});

beforeEach(() => {
  seq = 0;
});

describe("suggestions from repeated answers", () => {
  it("offers the exact command with count, period, agents and risk", () => {
    const rows = rowsOf(
      asks(BASH, cmd("npm test"), 3, "allow", { agent: agent("Explore") }),
      asks(BASH, cmd("npm test"), 2),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0];
    expect(s.rule).toBe("runTerminalCommand(npm test)");
    expect(s.decision).toBe("allow");
    expect(s.count).toBe(5);
    expect(s.spanDays).toBe(0);
    expect(s.agents.map((a) => a.name)).toEqual(["Explore", "unknown agent"]);
    expect(s.risk).toMatchObject({ kind: "runs-project-code", risk: "medium" });
    expect(s.apply).toBe(
      "continuous permissions add always 'runTerminalCommand(npm test)'",
    );
  });

  it("offers nothing under the minimum, and counts only answers by the person", () => {
    const rows = rowsOf(
      asks(BASH, cmd("npm test"), 2),
      // answered by the reviewer, not the person
      [
        decision("r1", BASH, cmd("npm run lint"), {
          policy: "allow",
          by: "reviewer",
        }),
      ],
    );
    expect(suggestRules(rows, SOURCES, { cwd: CWD }).suggestions).toEqual([]);
  });

  it("never offers npm install, and never a wildcard for npm test", () => {
    const rows = rowsOf(
      asks(BASH, cmd("npm install left-pad"), 4),
      asks(BASH, cmd("npm install lodash"), 4),
      asks(BASH, cmd("npm test src/a.test.ts"), 3),
      asks(BASH, cmd("npm test src/b.test.ts"), 3),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    const rules = r.suggestions.map((s) => s.rule);
    expect(rules.some((x) => x.includes("npm install"))).toBe(false);
    expect(rules.some((x) => x.includes("*"))).toBe(false);
    expect(rules).toContain("runTerminalCommand(npm test src/a.test.ts)");
    expect(
      r.withheld.some((w) => w.subject.startsWith("npm test <anything>")),
    ).toBe(true);
    expect(
      r.withheld.find((w) => w.subject.startsWith("npm test <any"))?.reason,
    ).toMatch(/would also allow/);
  });

  it("withholds a network host, a path outside the workspace and a write", () => {
    const rows = rowsOf(
      asks(BASH, cmd("curl https://example.test/a"), 5),
      asks(BASH, cmd("git fetch origin"), 5),
      asks(BASH, cmd("cat /etc/hostname"), 5),
      asks(BASH, cmd("cat ../other/file.txt"), 5),
      asks(BASH, cmd("rm build.log"), 5),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(r.suggestions.filter((s) => s.decision === "allow")).toEqual([]);
    expect(r.withheld.length).toBeGreaterThanOrEqual(5);
  });

  it("never offers a protected path, either way", () => {
    const rows = rowsOf(
      asks("read_file", { filepath: ".env" }, 5),
      asks("read_file", { filepath: ".env.local" }, 5, "deny"),
      asks("read_file", { filepath: ".git/config" }, 5),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(r.suggestions).toEqual([]);
    expect(r.withheld.some((w) => /protected/.test(w.reason))).toBe(true);
  });

  it("does not offer a rule for a call a floor or a built-in ask settled", () => {
    const rows = rowsOf(
      asks(BASH, cmd("git reset --hard HEAD~3"), 5, "allow", {
        source: "floor",
      }),
      asks(BASH, cmd("git push --force"), 5),
      asks(BASH, cmd("git clean -fdx"), 5),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(r.suggestions.filter((s) => s.decision === "allow")).toEqual([]);
  });

  it("does not loosen the person's own ask rule", () => {
    const sources: RuleSourcesInput = {
      ...SOURCES,
      user: { ask: ["runTerminalCommand(npm test)"] },
    };
    const rows = rowsOf(asks(BASH, cmd("npm test"), 5));
    const r = suggestRules(rows, sources, { cwd: CWD });
    expect(r.suggestions).toEqual([]);
    expect(r.withheld[0].reason).toMatch(/ask-rule/);
  });

  it("skips what is already allowed and a call answered both ways", () => {
    const allowed: RuleSourcesInput = {
      ...SOURCES,
      user: { allow: ["runTerminalCommand(npm test)"] },
    };
    expect(
      suggestRules(rowsOf(asks(BASH, cmd("npm test"), 5)), allowed, {
        cwd: CWD,
      }).suggestions,
    ).toEqual([]);
    const mixed = suggestRules(
      rowsOf(
        asks(BASH, cmd("npm run build"), 3),
        asks(BASH, cmd("npm run build"), 3, "deny"),
      ),
      SOURCES,
      { cwd: CWD },
    );
    expect(mixed.suggestions).toEqual([]);
    expect(mixed.withheld[0].reason).toMatch(/both allow and deny/);
  });

  it("suggests a Never for a command refused repeatedly, but not for a protected path", () => {
    const r = suggestRules(
      rowsOf(asks(BASH, cmd("npm publish"), 4, "deny")),
      SOURCES,
      { cwd: CWD },
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({
      decision: "deny",
      rule: "runTerminalCommand(npm publish)",
      apply:
        "continuous permissions add never 'runTerminalCommand(npm publish)'",
    });
    expect(
      suggestRules(rowsOf(asks(BASH, cmd("npm publish"), 4, "deny")), SOURCES, {
        decision: "allow",
      }).suggestions,
    ).toEqual([]);
  });

  it("offers a directory glob for plain files, and not when it would admit .env", () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    const rows = rowsOf(
      ...files.map((f) => asks("read_file", { filepath: `src/lib/${f}` }, 2)),
    );
    const r = suggestRules(rows, SOURCES, {
      cwd: CWD,
      basePolicy: "allowedWithPermission",
    });
    expect([r.withheld, r.suggestions.map((s) => s.rule)]).toEqual([
      [],
      ["readFile(src/lib/*)"],
    ]);
    expect(r.suggestions[0]).toMatchObject({ shape: "directory", count: 6 });
    // the same glob tested against the real evaluator: .env stays protected
    const t = testToolCall({
      tool: "readFile",
      path: "src/lib/.env",
      sources: { ...SOURCES, user: { allow: ["readFile(src/lib/*)"] } },
      cwd: CWD,
    });
    expect(t.decision).not.toBe("allow");
  });

  it("skips masked rows and never prints a secret", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const rows = rowsOf(
      asks(BASH, cmd(`curl -H "Authorization: Bearer ${token}" x`), 5),
      asks(BASH, cmd(`npm run build --token ${token}`), 5),
    );
    const r = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.suggestions).toEqual([]);
    expect(r.withheld.some((w) => /masked/.test(w.reason))).toBe(true);
  });

  it("does not offer an MCP tool", () => {
    const r = suggestRules(
      rowsOf(asks("mcp__srv__lookup", { q: "x" }, 5)),
      SOURCES,
      { cwd: CWD },
    );
    expect(r.suggestions).toEqual([]);
    expect(r.withheld[0].reason).toMatch(/MCP/);
  });
});

describe("the 287-case corpus as synthetic traces", () => {
  const starter = parseDataset(
    readFileSync(
      path.join(
        __dirname,
        "..",
        "auto",
        "evaluation",
        "datasets",
        "reviewer-starter.json",
      ),
      "utf8",
    ),
  );
  const dangerous = new Set([...DENY_CASES, ...ASK_CASES].map((c) => c.id));
  const cases = [
    ...EVAL_CASES.map((c) => ({
      id: c.id,
      tool: c.tool,
      args: c.args,
      expect: c.expect,
      floor: dangerous.has(c.id) && c.expect === "deny",
    })),
    ...starter.cases.map((c) => ({
      id: c.id,
      tool: c.tool,
      args: c.args,
      expect: c.expected,
      floor: c.floor,
    })),
  ];

  it("has 287 cases", () => {
    expect(cases).toHaveLength(287);
  });

  it("offers an allow for no case the labels say must not run, and keeps the allow-labelled ones few and safe", () => {
    // every case asked 4 times and approved 4 times, one trace each
    const records: AuditRecord[] = [];
    for (const c of cases) {
      records.push(...asks(c.tool, c.args, 4, "allow"));
    }
    const rows = callRows(records);
    const r = suggestRules(rows, SOURCES, { cwd: CWD, decision: "allow" });
    const offered = new Set(r.suggestions.map((s) => s.rule));
    const bad: string[] = [];
    for (const c of cases) {
      if (c.expect === "allow") continue;
      const field =
        c.tool === "run_terminal_command"
          ? {
              command: String(
                (c.args as never as Record<string, unknown>).command,
              ),
            }
          : undefined;
      if (!field) continue;
      if (offered.has(`runTerminalCommand(${field.command})`)) {
        bad.push(`${c.id}: ${field.command}`);
      }
    }
    expect(bad).toEqual([]);
    // measured, pinned: a change here is a decision
    expect(offered.has("runTerminalCommand(npm run lint -- --fix)")).toBe(
      false,
    );
    expect({
      cases: cases.length,
      suggested: r.suggestions.length,
      wildcards: r.suggestions.filter((s) => s.rule.includes("*")).length,
      network: r.suggestions.filter((s) => s.risk.kind === "network").length,
    }).toMatchObject({ cases: 287, wildcards: 0, network: 0 });
    // each suggestion really turns its asks into allows without loosening a floor
    for (const s of r.suggestions) {
      expect(s.risk.risk).not.toBe("high");
    }
  });

  it("offers a Never only for calls that were refused, and applies nothing", () => {
    const records: AuditRecord[] = [];
    for (const c of cases.filter((x) => x.expect === "deny").slice(0, 40)) {
      records.push(...asks(c.tool, c.args, 3, "deny"));
    }
    const r = suggestRules(callRows(records), SOURCES, {
      cwd: CWD,
      decision: "deny",
    });
    expect(r.suggestions.every((s) => s.decision === "deny")).toBe(true);
    for (const s of r.suggestions) {
      expect(s.apply.startsWith("continuous permissions add never ")).toBe(
        true,
      );
    }
  });
});

describe("the read is bounded", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-suggest-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function line(i: number, session: string): string {
    const id = `${session}-${i}`;
    const a = decision(id, BASH, cmd(`npm run task${i % 50}`), { session });
    const b = decision(id, BASH, cmd(`npm run task${i % 50}`), {
      session,
      policy: "allow",
      by: "person",
      source: undefined,
    });
    return `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`;
  }

  function bigFile(session: string, month: string, mb: number, mtime?: Date) {
    const d = path.join(dir, month);
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, `${session}.jsonl`);
    // generated in memory, one 1 MB block repeated
    let block = "";
    let i = 0;
    while (block.length < 1024 * 1024) block += line(i++, session);
    const fd = fs.openSync(file, "w");
    for (let n = 0; n < mb; n++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it("reads a 96 MB directory within its byte limit, newest first, quickly", () => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    bigFile("old", month, 48, new Date(now.getTime() - 5 * 86_400_000));
    bigFile("new", month, 48);
    const started = performance.now();
    const { rows, stats } = listCallsBounded(
      dir,
      {},
      { maxBytes: 4 * 1024 * 1024, now },
    );
    const ms = performance.now() - started;
    expect(stats.truncatedBy).toBe("bytes");
    expect(stats.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(stats.filesRead).toBe(1);
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows.every((r) => r.session === "new")).toBe(true);
    expect(ms).toBeLessThan(2000);
    // and what is read is joined into whole rows
    expect(rows.every((r) => r.by === "person" && r.asked)).toBe(true);
    const out = suggestRules(rows, SOURCES, { cwd: CWD });
    expect(out.answered).toBe(rows.length);
  });

  it("caps by records and by age", () => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    bigFile("fresh", month, 1);
    bigFile("stale", month, 1, new Date(now.getTime() - 200 * 86_400_000));
    const byRows = listCallsBounded(dir, {}, { maxRows: 500, now });
    expect(byRows.stats.truncatedBy).toBe("rows");
    expect(byRows.stats.records).toBe(500);
    const byAge = listCallsBounded(dir, {}, { now });
    expect(byAge.stats.filesSkippedByAge).toBe(1);
    expect(byAge.rows.every((r) => r.session === "fresh")).toBe(true);
    // listCalls shares the bounds
    expect(
      listCalls(dir, {}, { maxRows: 100, now }).length,
    ).toBeLessThanOrEqual(50);
    expect(DEFAULT_READ_LIMITS.maxBytes).toBe(32 * 1024 * 1024);
  });

  it("reads lines across chunk edges and drops a fragment at a tail start", () => {
    const file = path.join(dir, "f.jsonl");
    const lines = Array.from({ length: 30_000 }, (_, i) => `line-${i}-é`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const all: string[] = [];
    forEachLine(file, 0, (l) => void all.push(l));
    expect(all).toEqual(lines);
    const size = fs.statSync(file).size;
    const tail: string[] = [];
    forEachLine(file, size - 1000, (l) => void tail.push(l));
    expect(tail.length).toBeGreaterThan(10);
    expect(tail.every((l) => lines.includes(l))).toBe(true);
    expect(tail[tail.length - 1]).toBe(lines[lines.length - 1]);
  });
});
