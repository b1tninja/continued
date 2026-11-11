import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findLinks, plan } from "./worktree-hygiene.mjs";

const g = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

test("report lists junctions and the removal plan, deletes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "wh-"));
  const d = join(root, "repo");
  mkdirSync(d);
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  writeFileSync(join(d, "f"), "1\n");
  writeFileSync(join(d, ".gitignore"), "node_modules\n");
  g(d, "add", "-A");
  g(d, "commit", "-qm", "base");
  // merged + clean worktree with a junctioned node_modules
  const merged = join(root, "wt-merged");
  g(d, "worktree", "add", "-q", "-b", "done", merged);
  const target = join(root, "shared_modules");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "precious\n");
  symlinkSync(target, join(merged, "node_modules"), "junction");
  // unmerged worktree
  const open = join(root, "wt-open");
  g(d, "worktree", "add", "-q", "-b", "open", open);
  writeFileSync(join(open, "g"), "2\n");
  g(open, "add", "-A");
  g(open, "commit", "-qm", "wip");
  // a dirty merged worktree
  const dirty = join(root, "wt-dirty");
  g(d, "worktree", "add", "-q", "-b", "dirty", dirty);
  writeFileSync(join(dirty, "untracked"), "x\n");

  const script = resolve(import.meta.dirname, "worktree-hygiene.mjs");
  const r = spawnSync("node", [script, "--base", "main"], {
    cwd: d,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(
    out,
    /wt-merged.*merged-into-main=true.*links=1.*SAFE TO REMOVE/,
  );
  assert.match(out, /wt-open.*merged-into-main=false.*keep/);
  assert.match(out, /wt-dirty.*clean=false.*keep/);
  assert.match(out, /\$ (cmd \/c rmdir|rm) .*node_modules/);
  assert.match(out, /\$ git worktree remove .*wt-merged/);
  assert.doesNotMatch(out, /git worktree remove .*wt-(open|dirty)/);
  // nothing was deleted
  assert.ok(existsSync(join(merged, "node_modules", "keep.txt")));
  assert.ok(existsSync(open) && existsSync(dirty));
  assert.equal(g(d, "worktree", "list").split("\n").length, 4);
  assert.deepEqual(findLinks(merged), [join(merged, "node_modules")]);
});

test("plan unlinks links before removing the worktree", () => {
  const p = plan("C:/w/a", ["C:/w/a/node_modules"], true);
  assert.equal(p[0], String.raw`cmd /c rmdir "C:\w\a\node_modules"`);
  assert.equal(p.at(-1), String.raw`git worktree remove "C:\w\a"`);
});
