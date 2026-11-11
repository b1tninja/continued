import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectsFor, runTrial, trialPlan } from "./trial-merge.mjs";

const g = (cwd, ...a) =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();
const put = (cwd, f, t) => {
  mkdirSync(join(cwd, f, ".."), { recursive: true });
  writeFileSync(join(cwd, f), t);
};

test("projectsFor maps changed files to projects", () => {
  assert.deepEqual(projectsFor(["docs/a.md", "plans/ROADMAP.md"]), []);
  assert.deepEqual(projectsFor(["gui/src/a.ts"]), ["gui"]);
  assert.deepEqual(projectsFor(["binary/x.ts"]), ["binary"]);
  assert.deepEqual(projectsFor(["core/a.ts"]), ["core", "gui", "binary"]);
  assert.deepEqual(projectsFor(["package-lock.json"]), [
    "core",
    "gui",
    "binary",
  ]);
});

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "trial-"));
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  put(d, "core/a.ts", "export type T = { a: 1 };\n");
  put(d, "gui/b.ts", "x\n");
  g(d, "add", "-A");
  g(d, "commit", "-qm", "base");
  g(d, "checkout", "-q", "-b", "pr");
  put(d, "gui/b.ts", "y\n");
  g(d, "commit", "-qam", "pr");
  g(d, "checkout", "-q", "main");
  put(d, "core/a.ts", "export type T = { a: 1; b: 2 };\n");
  g(d, "commit", "-qam", "main moves");
  return d;
}

test("trialPlan: behind PR merges clean and picks projects from both sides", () => {
  const d = fixture();
  const p = trialPlan(d, "main", "pr");
  assert.equal(p.behind, 1);
  assert.equal(p.conflict, false);
  assert.deepEqual(p.projects, ["core", "gui", "binary"]);
  assert.match(p.commit, /^[0-9a-f]{40}$/);
});

test("trialPlan: a PR that contains main needs no trial", () => {
  const d = fixture();
  g(d, "checkout", "-q", "pr");
  g(d, "merge", "-q", "--no-edit", "main");
  g(d, "checkout", "-q", "main");
  const p = trialPlan(d, "main", "pr");
  assert.equal(p.behind, 0);
  assert.deepEqual(p.projects, []);
});

test("trialPlan reports a conflict", () => {
  const d = fixture();
  g(d, "checkout", "-q", "pr");
  put(d, "core/a.ts", "export type T = { z: 1 };\n");
  g(d, "commit", "-qam", "pr edits core");
  g(d, "checkout", "-q", "main");
  const p = trialPlan(d, "main", "pr");
  assert.equal(p.conflict, true);
  assert.deepEqual(p.files, ["core/a.ts"]);
});

test("runTrial runs commands in the merged tree and cleans up", () => {
  const d = fixture();
  const p = trialPlan(d, "main", "pr");
  const seen = [];
  const res = runTrial(d, p.commit, ["gui"], d, (bin, args, opts) => {
    seen.push({
      bin,
      args,
      cwd: opts.cwd,
      merged: existsSync(join(opts.cwd, "b.ts")),
    });
    return { status: args[0] === "run" ? 1 : 0 };
  });
  assert.deepEqual(
    res.map((r) => r.status),
    [0, 1],
  );
  assert.ok(seen.every((s) => s.merged));
  assert.ok(seen[0].cwd.endsWith("gui"));
  assert.ok(!existsSync(seen[0].cwd));
  assert.equal(g(d, "worktree", "list").split("\n").length, 1);
});
