"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  tokens,
  tableRows,
  parseRoadmap,
  matches,
  planTracks,
  checkPlan,
  lookup,
} = require("./roadmap-ids.js");

const ROADMAP = [
  "### Track Q: tool-call styles",
  "",
  "Plan: [`tool-dialects.md`](./tool-dialects.md)",
  "",
  "| PR  | Scope | State |",
  "| --- | ----- | ----- |",
  "| Q1  | Spike: chat template and parser per served model | open |",
  "| Q2  | Integer coercion for numeric strings in arguments | open |",
  "| C11a | Stop carrying escalation between conversations | done |",
  "| C11b | Escalate at the fifth request | done |",
  "",
  "## Later",
].join("\n");

test("parses rows with pipes inside backticks", () => {
  const rows = tableRows("| Q9 | a `x|y` scope | dep |");
  assert.deepStrictEqual(
    rows.map((r) => [r.id, r.scope]),
    [["Q9", "a `x|y` scope"]],
  );
});

test("maps plans to tracks and rows to scopes", () => {
  assert.deepStrictEqual(
    [...planTracks(ROADMAP).get("tool-dialects.md")],
    ["Q"],
  );
  assert.strictEqual(parseRoadmap(ROADMAP).size, 4);
});

test("matches is conservative", () => {
  assert.ok(
    matches(
      "Integer coercion of numeric strings",
      "Integer coercion for numeric strings in arguments",
    ),
  );
  assert.ok(
    !matches(
      "Render path for qwen-xml",
      "Integer coercion for numeric strings in arguments",
    ),
  );
  assert.ok(tokens("Per-item meters").has("meter"));
});

test("a bare id names its lettered rows", () => {
  const rm = parseRoadmap(ROADMAP);
  assert.ok(lookup(rm, "C11"));
  assert.strictEqual(lookup(rm, "C12"), undefined);
});

test("flags a plan row that reuses an id for another scope", () => {
  const rm = parseRoadmap(ROADMAP);
  const plan = [
    "| Row | Slice |",
    "| --- | --- |",
    "| Q2 | Render path for qwen-xml dialect |",
    "| Q7 | New proposal |",
  ].join("\n");
  const kinds = checkPlan("p.md", plan, rm, new Set(["Q"])).map((f) => [
    f.id,
    f.kind,
  ]);
  assert.deepStrictEqual(kinds, [
    ["Q2", "drift"],
    ["Q7", "unlisted"],
  ]);
});

test("ignores local id series and flags unknown owned-track ids in prose", () => {
  const rm = parseRoadmap(ROADMAP);
  const plan =
    "| D1 | A decision |\nSee D1 and row Z9, and Q99 for coercion of numeric strings.";
  const found = checkPlan("p.md", plan, rm, new Set(["Q"])).map((f) => [
    f.id,
    f.kind,
  ]);
  assert.deepStrictEqual(found, [
    ["Q99", "missing"],
    ["Z9", "missing"],
  ]);
});

test("a slice letter does not drift from its row", () => {
  const rm = parseRoadmap(ROADMAP);
  const plan = "| Q2a | Something entirely different |";
  assert.deepStrictEqual(checkPlan("p.md", plan, rm, new Set(["Q"])), []);
});
