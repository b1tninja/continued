import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditSuggestCommand } from "./auditSuggest.js";

let dir: string;
let home: string;
let lines: string[];
let errs: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-suggest-audit-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-suggest-home-"));
  lines = [];
  errs = [];
  const trail = new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-10T12:00:00Z"),
    syncImportant: false,
  });
  const ask = (id: string, command: string, approve: boolean) => {
    trail.decision({
      session: "s1",
      callId: id,
      tool: "run_terminal_command",
      args: JSON.stringify({ command }),
      policy: "ask",
      by: "rules",
      source: "manual",
    });
    trail.answer(id, approve);
  };
  for (let i = 0; i < 4; i++) ask(`t${i}`, "npm test", true);
  for (let i = 0; i < 4; i++) ask(`i${i}`, "npm install left-pad", true);
  for (let i = 0; i < 3; i++) ask(`p${i}`, "npm publish", false);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const io = {
  out: (l: string) => void lines.push(l),
  err: (l: string) => void errs.push(l),
};
const run = (extra: Record<string, unknown> = {}) =>
  auditSuggestCommand(
    {
      dir,
      configFile: path.join(home, "config.yaml"),
      permissionsFile: path.join(home, "permissions.yaml"),
      cwd: home,
      ...extra,
    },
    io,
  );

describe("continuous audit suggest", () => {
  it("prints rules with count, period, agents and risk, and changes nothing", () => {
    expect(run()).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("ALWAYS  runTerminalCommand(npm test)");
    expect(text).toContain("allowed 4 times");
    expect(text).toContain("agents: unknown agent 4");
    expect(text).toContain("risk: medium (runs-project-code");
    expect(text).toContain(
      "apply: continuous permissions add always 'runTerminalCommand(npm test)'",
    );
    expect(text).toContain("NEVER  runTerminalCommand(npm publish)");
    expect(text).not.toContain("npm install left-pad)");
    expect(text).toContain("Nothing was changed");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("says why only in verbose mode", () => {
    run();
    expect(lines.join("\n")).not.toContain("npm install left-pad (");
    lines.length = 0;
    run({ verbose: true });
    expect(lines.join("\n")).toMatch(/npm install left-pad \(4\)/);
  });

  it("filters by decision, honours --min and prints JSON", () => {
    run({ decision: "deny", json: true });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.suggestions.map((s: { rule: string }) => s.rule)).toEqual([
      "runTerminalCommand(npm publish)",
    ]);
    expect(parsed.stats.records).toBeGreaterThan(0);
    lines.length = 0;
    run({ min: 5, json: true });
    expect(JSON.parse(lines[0]).suggestions).toEqual([]);
    expect(run({ decision: "maybe" })).toBe(2);
    expect(errs[0]).toMatch(/allow or deny/);
  });
});
