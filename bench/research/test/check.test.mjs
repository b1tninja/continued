import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compare, exitCode, formatCheck, summarise } from "../lib/check.mjs";
import { report } from "../lib/report.mjs";
import {
  parseRegexList,
  parseTable,
  loadTable,
  resolveRow,
} from "../lib/table.mjs";
import { AGREEING_ROWS, FIX, HERE, dataset, tableText } from "./helpers.mjs";

const MRT = join(HERE, "..", "mrt.mjs");
const CORE_TABLE = join(
  HERE,
  "..",
  "..",
  "..",
  "core",
  "util",
  "toolDialectPresetTable.ts",
);

test("regex literals with slashes inside classes and flags parse", () => {
  const [a, b] = parseRegexList("/a[/]b|c/, /x\\/y/i,");
  assert.ok(a.test("a/b"));
  assert.ok(b.test("X/Y"));
});

test("the real preset table parses (text only, nothing imported from core)", () => {
  const rows = loadTable(CORE_TABLE);
  assert.ok(rows.length >= 20);
  assert.ok(rows.every((r) => r.id && r.textDialect && r.match.length > 0));
  assert.equal(
    resolveRow(rows, "Qwen/Qwen3-Coder-30B-A3B-Instruct").textDialect,
    "qwen-xml",
  );
});

test("a table that does not parse is an error, not a skip", () => {
  assert.throws(() => parseTable("export const TOOL_DIALECT_PRESETS = [];"));
  assert.throws(() => parseTable("nothing here"));
});

test("agreeing table: no disagreement, undecided stays undecided, exit 0", () => {
  const rows = parseTable(tableText(AGREEING_ROWS));
  const result = compare(rows, dataset());
  const s = summarise(result);
  assert.equal(s.disagree, 0);
  assert.ok(s.agree >= 15);
  assert.ok(
    s.undecided >= 4,
    "Kimi-K3, MiniMax-M3, DeepSeek-V3.2 and the Mistral repos are undecided",
  );
  assert.ok(s.unavailable >= 4, "the four gated repos");
  for (const f of result.findings) {
    if (f.template.outcome === "undecided")
      assert.notEqual(f.kind, "agree", f.repo);
  }
  assert.equal(exitCode(result), 0);
  assert.equal(
    exitCode(result, { strict: true }),
    1,
    "strict refuses undecided",
  );
  assert.deepEqual(
    result.uncovered.map((u) => u.row),
    ["claude"],
  );
  assert.equal(result.uncovered[0].kind, "no-public-template");
});

test("the Qwen3-Next / 3.5 / 3.6 drift is a disagreement and exits 1", () => {
  // the pre-correction layout: qwen3-next in the coder row, 3.5 and 3.6 in the hermes row
  const rows = parseTable(
    tableText([
      {
        id: "nemotron-3",
        match: "/nemotron[-._ ]?3/",
        dialect: "qwen-xml",
        sources: [],
      },
      {
        id: "qwen3-coder",
        match: "/qwen[-._ ]?3[-._ ]?coder|qwen[-._ ]?3[-._ ]?next/",
        dialect: "qwen-xml",
        sources: [],
      },
      {
        id: "qwen3",
        match: "/qwen[-._ ]?(?:3|2[.-]?5)|hermes/",
        dialect: "hermes-json",
        sources: [],
      },
      ...AGREEING_ROWS.filter((r) => !r.id.startsWith("qwen")),
    ]),
  );
  const result = compare(rows, dataset());
  const bad = result.findings
    .filter((f) => f.kind === "disagree")
    .map((f) => f.repo)
    .sort();
  assert.deepEqual(bad, [
    "Qwen/Qwen3-Next-80B-A3B-Instruct",
    "Qwen/Qwen3.5-27B",
    "Qwen/Qwen3.6-27B",
  ]);
  assert.equal(exitCode(result), 1);
  assert.match(formatCheck(result), /DISAGREE\s+Qwen\/Qwen3.5-27B/);
});

test("a repo no row matches is unresolved, and report renders tables", () => {
  const rows = parseTable(tableText([AGREEING_ROWS[0]]));
  const result = compare(rows, dataset());
  assert.ok(summarise(result).unresolved > 10);
  const md = report(result, dataset());
  assert.match(md, /^# Template classification/);
  assert.match(md, /\| repo \| licence \|/);
});

function run(args) {
  return spawnSync(process.execPath, [MRT, ...args], { encoding: "utf8" });
}

test("CLI: check exits 0 clean, 1 on disagreement, 2 when it cannot check", () => {
  const dir = mkdtempSync(join(tmpdir(), "mrt-test-"));
  const good = join(dir, "good.ts");
  const bad = join(dir, "bad.ts");
  writeFileSync(good, tableText(AGREEING_ROWS));
  writeFileSync(
    bad,
    tableText([
      { id: "qwen", match: "/qwen/", dialect: "hermes-json", sources: [] },
    ]),
  );
  const data = join(FIX, "dataset.json");
  assert.equal(run(["check", "--data", data, "--table", good]).status, 0);
  assert.equal(run(["check", "--data", data, "--table", bad]).status, 1);
  assert.equal(
    run(["check", "--data", data, "--table", join(dir, "missing.ts")]).status,
    2,
  );
  assert.equal(
    run(["check", "--data", join(dir, "missing.json"), "--table", good]).status,
    2,
  );
  assert.equal(run(["report", "--data", data, "--table", good]).status, 0);
});

test("CLI: fetch offline with an empty cache is exit 2 and sends nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "mrt-test-"));
  const r = run([
    "fetch",
    "--offline",
    "--cache",
    dir,
    "--repo",
    "Qwen/Qwen3-30B-A3B",
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /offline and not cached/);
});
