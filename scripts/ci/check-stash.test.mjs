import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyze, parseWorktrees, stashBranch } from "./check-stash.mjs";

test("stashBranch and analyze classify messages", () => {
  assert.equal(stashBranch("WIP on feat-a: abc1234 msg"), "feat-a");
  assert.equal(stashBranch("On feat-b: named"), "feat-b");
  assert.equal(stashBranch("lint-staged automatic backup (abc)"), null);
  const wts = parseWorktrees(
    "worktree /r\nbranch refs/heads/main\n\nworktree /w\nbranch refs/heads/feat-a\n",
  );
  const rows = analyze(
    [
      { ref: "stash@{0}", subject: "WIP on feat-a: x" },
      { ref: "stash@{1}", subject: "lint-staged automatic backup (1)" },
      { ref: "stash@{2}", subject: "WIP on gone: x" },
      { ref: "stash@{3}", subject: "WIP on main: x" },
    ],
    wts,
    "main",
  );
  assert.match(rows[0].notes[0], /do NOT pop/);
  assert.match(rows[1].notes[0], /lint-staged backup/);
  assert.match(rows[2].notes[0], /no worktree/);
  assert.deepEqual(rows[3].notes, []);
});

test("CLI in a temp repo with a linked worktree sees the shared stash", () => {
  const d = mkdtempSync(join(tmpdir(), "cs-"));
  const g = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  writeFileSync(join(d, "f"), "1\n");
  g(d, "add", "-A");
  g(d, "commit", "-qm", "base");
  const wt = join(d, "..", "cs-wt-" + Date.now());
  g(d, "worktree", "add", "-q", "-b", "feat-a", wt);
  writeFileSync(join(wt, "f"), "2\n");
  g(wt, "stash"); // the test repo is throwaway; this is the behaviour under test
  const script = resolve(import.meta.dirname, "check-stash.mjs");
  const r = spawnSync("node", [script, "--strict"], {
    cwd: d,
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /belongs to the worktree of branch feat-a/);
  const ok = spawnSync("node", [script], { cwd: wt, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.stdout, /do NOT pop/);
});
