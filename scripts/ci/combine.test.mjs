import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { combineMatrix, formatMatrix, mergeTree } from "./combine.mjs";

const g = (cwd, ...a) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

function put(cwd, file, text) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
}

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "combine-"));
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  put(d, "a.txt", "1\n2\n3\n");
  put(d, "docs/ROADMAP.md", "x\n");
  g(d, "add", "-A");
  g(d, "commit", "-qm", "base");
  const branch = (name, file, text) => {
    g(d, "checkout", "-q", "-b", name, "main");
    put(d, file, text);
    g(d, "add", "-A");
    g(d, "commit", "-qm", name);
  };
  branch("p1", "a.txt", "1\nONE\n3\n");
  branch("p2", "a.txt", "1\nTWO\n3\n");
  branch("p3", "b.txt", "new\n");
  branch("p4", "docs/ROADMAP.md", "y\n");
  branch("p5", "docs/ROADMAP.md", "z\n");
  g(d, "checkout", "-q", "main");
  return d;
}

test("matrix reports conflicts, clean pairs and hot files; touches nothing", () => {
  const d = fixture();
  const before = g(d, "status", "--porcelain=v1") + g(d, "rev-parse", "HEAD");
  const refs = { p1: "p1", p2: "p2", p3: "p3", p4: "p4", p5: "p5" };
  const r = combineMatrix(d, "main", refs);
  const pair = (a, b) => r.pairs.find((p) => p.a === a && p.b === b);
  assert.equal(pair("p1", "p2").status, "conflict");
  assert.deepEqual(pair("p1", "p2").conflicts, ["a.txt"]);
  assert.equal(pair("p1", "p3").status, "clean");
  assert.deepEqual(pair("p1", "p3").shared, []);
  assert.equal(pair("p4", "p5").status, "conflict");
  assert.deepEqual(pair("p4", "p5").hot, ["docs/ROADMAP.md"]);
  assert.ok(r.alone.p1.clean);
  assert.match(formatMatrix(r), /p1 \+ p2: CONFLICT/);
  // read-only: same HEAD, same (empty) status, same branch list
  assert.equal(
    g(d, "status", "--porcelain=v1") + g(d, "rev-parse", "HEAD"),
    before,
  );
  assert.equal(g(d, "branch", "--list").split("\n").length, 6);
  assert.deepEqual(readdirSync(d).sort(), [".git", "a.txt", "docs"]);
});

test("a ref that already conflicts with main is reported and its pairs skipped", () => {
  const d = fixture();
  g(d, "checkout", "-q", "main");
  put(d, "a.txt", "1\nMAIN\n3\n");
  g(d, "commit", "-qam", "main moves");
  assert.equal(mergeTree(d, "main", "p1").clean, false);
  const r = combineMatrix(d, "main", { p1: "p1", p3: "p3" });
  assert.equal(r.alone.p1.clean, false);
  assert.equal(r.pairs[0].status, "skipped");
});
