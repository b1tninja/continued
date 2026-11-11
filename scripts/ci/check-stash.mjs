#!/usr/bin/env node
// Read-only: warn about entries in the repository-wide stash list (refs/stash is shared by ALL
// worktrees of one repository, so a `git stash pop` in worktree B can apply worktree A's WIP).
//   node scripts/ci/check-stash.mjs [--strict]     (--strict: exit 1 when any stash exists)
// Classifies every stash by the branch recorded in its message ("WIP on <branch>: ..." or
// "On <branch>: ...") and by lint-staged's "automatic backup" entries.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) out.push((cur = { path: line.slice(9) }));
    else if (cur && line.startsWith("branch "))
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line === "detached") cur.detached = true;
  }
  return out;
}

export function stashBranch(subject) {
  const m = /^(?:WIP on|On) ([^:]+):/.exec(subject);
  return m ? m[1] : null;
}

/** stashes: [{ref, subject}], worktrees from parseWorktrees, currentBranch: string|null. */
export function analyze(stashes, worktrees, currentBranch) {
  const byBranch = new Map(
    worktrees.filter((w) => w.branch).map((w) => [w.branch, w.path]),
  );
  return stashes.map((s) => {
    const branch = stashBranch(s.subject);
    const notes = [];
    if (/lint-staged automatic backup/i.test(s.subject))
      notes.push(
        "lint-staged backup left behind by a failed or interrupted hook (see CONTRIBUTING: lint-staged runs with --no-stash)",
      );
    if (branch && branch !== currentBranch && byBranch.has(branch))
      notes.push(
        `belongs to the worktree of branch ${branch} (${byBranch.get(branch)}): do NOT pop it here`,
      );
    else if (branch && branch !== currentBranch)
      notes.push(`recorded on branch ${branch}, which has no worktree here`);
    return { ...s, branch, notes };
  });
}

function main() {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
  const stashes = git("stash", "list", "--format=%gd%x09%gs")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [ref, ...rest] = l.split("\t");
      return { ref, subject: rest.join("\t") };
    });
  const current = git("branch", "--show-current").trim() || null;
  const rows = analyze(
    stashes,
    parseWorktrees(git("worktree", "list", "--porcelain")),
    current,
  );
  if (!rows.length) return console.log("no stashes: nothing to warn about");
  console.log(
    `${rows.length} stash(es) in the SHARED list (current branch: ${current}):`,
  );
  for (const r of rows) {
    console.log(`  ${r.ref}  ${r.subject}`);
    for (const n of r.notes) console.log(`      ! ${n}`);
  }
  console.log(
    "\nNever `git stash` here; commit WIP (scripts/agents/checkpoint.sh). Inspect with `git stash show -p <ref>`; the owner drops entries.",
  );
  if (process.argv.includes("--strict")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
