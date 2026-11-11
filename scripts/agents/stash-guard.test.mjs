import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const dir = import.meta.dirname;
const g = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const gs = (cwd, env, ...a) =>
  spawnSync("git", a, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("guard blocks git stash and lint-staged style stash store, keeps work, can be overridden", () => {
  const d = mkdtempSync(join(tmpdir(), "sg-"));
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  // husky-like layout: relative core.hooksPath to an untracked directory
  mkdirSync(join(d, ".husky", "_"), { recursive: true });
  g(d, "config", "core.hooksPath", ".husky/_");
  writeFileSync(join(d, "f"), "1\n");
  g(d, "add", "-A");
  g(d, "commit", "-qm", "base");
  const inst = spawnSync("sh", [resolve(dir, "install-stash-guard.sh")], {
    cwd: d,
    encoding: "utf8",
  });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(d, ".husky", "_", "reference-transaction")));

  writeFileSync(join(d, "f"), "2\n");
  const r = gs(d, {}, "stash");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stash-guard/);
  assert.equal(g(d, "stash", "list"), "");
  assert.match(g(d, "status", "--porcelain"), /^M f/); // work untouched
  // the lint-staged backup path: create + store
  const c = g(d, "stash", "create");
  const s = gs(d, {}, "stash", "store", c);
  assert.notEqual(s.status, 0);
  // ordinary commits are not affected
  g(d, "commit", "-qam", "two");
  // explicit override works
  writeFileSync(join(d, "f"), "3\n");
  assert.equal(gs(d, { GIT_ALLOW_STASH: "1" }, "stash").status, 0);
});
