#!/usr/bin/env node
// READ-ONLY worktree report. It never deletes, unlinks or modifies anything: it only prints the
// commands a person can run.
//   node scripts/ci/worktree-hygiene.mjs [--base origin/main]
// For each linked worktree: branch, clean?, merged into the base (ancestry), and junctions /
// symlinks (reparse points, e.g. a junctioned node_modules). Removing a worktree that contains a
// junction with a recursive delete follows the link and deletes the TARGET's files, so the printed
// plan unlinks each junction first with `cmd /c rmdir` (removes only the link) and then runs
// `git worktree remove`.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWorktrees } from "./check-stash.mjs";

const SKIP = new Set([".git"]);

/** Links (symlinks and Windows junctions; lstat reports both as symbolic links), depth <= maxDepth. */
export function findLinks(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) found.push(p);
      else if (
        st.isDirectory() &&
        e.name !== "node_modules" &&
        depth < maxDepth
      )
        walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

export function plan(wt, junctions, win = process.platform === "win32") {
  const q = (p) => `"${win ? p.replace(/\//g, "\\") : p}"`;
  const cmds = junctions.map((j) =>
    win ? `cmd /c rmdir ${q(j)}` : `rm ${q(j)}`,
  );
  cmds.push(`git worktree remove ${q(wt)}`);
  return cmds;
}

function main() {
  const git = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const bi = process.argv.indexOf("--base");
  const base = bi >= 0 ? process.argv[bi + 1] : "origin/main";
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  const all = parseWorktrees(git(top, "worktree", "list", "--porcelain"));
  const main0 = all[0].path;
  for (const w of all.slice(1)) {
    const clean = git(w.path, "status", "--porcelain") === "";
    let merged = false;
    if (w.branch)
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", w.branch, base], {
          cwd: top,
          stdio: "ignore",
        });
        merged = true;
      } catch {}
    const links = findLinks(w.path);
    const safe = clean && merged;
    console.log(
      `${w.path}  [${w.branch ?? "detached"}]  clean=${clean} merged-into-${base}=${merged}` +
        `  links=${links.length}  ${safe ? "SAFE TO REMOVE" : "keep"}`,
    );
    for (const l of links) console.log(`    link: ${l}`);
    if (safe) for (const c of plan(w.path, links)) console.log(`    $ ${c}`);
  }
  console.log(
    `\nmain worktree: ${main0} (never listed for removal). Merged = ancestry only: a squash-merged branch shows merged=false; check the PR before removing. Nothing was deleted.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
