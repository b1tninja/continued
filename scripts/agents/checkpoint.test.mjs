import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "checkpoint.sh");
const g = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const run = (cwd, env = {}) =>
  spawnSync("sh", [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ckpt-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, work);
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "f.txt"), "1\n");
  g(work, "add", "-A");
  g(work, "commit", "-qm", "base");
  g(work, "push", "-q", "origin", "main");
  return { origin, work };
}

test("refuses on main", () => {
  const { work } = fixture();
  writeFileSync(join(work, "f.txt"), "2\n");
  const r = run(work);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing on main/);
  assert.equal(g(work, "log", "--oneline").split("\n").length, 1);
});

test("commits wip and pushes the branch; second run is a no-op", () => {
  const { origin, work } = fixture();
  g(work, "checkout", "-q", "-b", "feat");
  writeFileSync(join(work, "f.txt"), "2\n");
  writeFileSync(join(work, "new.txt"), "n\n");
  const r = run(work);
  assert.equal(r.status, 0, r.stderr);
  assert.match(g(origin, "log", "-1", "--format=%s", "feat"), /^wip: /);
  assert.equal(g(work, "status", "--porcelain"), "");
  assert.equal(g(work, "stash", "list"), "");
  const again = run(work);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing new/);
});

test("detached HEAD is refused", () => {
  const { work } = fixture();
  g(work, "checkout", "-q", "--detach");
  assert.equal(run(work).status, 2);
});
