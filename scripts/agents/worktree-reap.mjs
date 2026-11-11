#!/usr/bin/env node
// Reap stale agent worktrees. Dry run by default: prints a table and deletes nothing.
//   node scripts/agents/worktree-reap.mjs [--root D:/temp] [--dry-run] [--apply] [--repo owner/name]
// A worktree is SAFE-TO-REMOVE only when ALL hold:
//   - it is under --root, is not the main worktree, and has a branch;
//   - the branch has no commits missing from its upstream (or origin/<branch>);
//   - its PR is merged or closed (gh pr list --head <branch> --state all). If gh is missing the
//     PR check is skipped with a warning and the branch must instead be an ancestor of origin/main;
//   - the working tree has no uncommitted changes;
//   - no process has its path on the command line or files open there (best effort).
// Removal: links are removed link-only (never followed), real node_modules is deleted, then
// `git worktree remove` WITHOUT --force. The main worktree is never touched.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWorktrees } from "../ci/check-stash.mjs";
import { findLinks } from "../ci/worktree-hygiene.mjs";
import {
  dirSize,
  fmtBytes,
  realRun,
  removeLink,
  removeTree,
} from "./worktree-lib.mjs";

const norm = (p) =>
  resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const under = (p, root) => norm(p).startsWith(norm(root) + "/");

/** owner/name of the origin remote. gh without --repo may resolve to the upstream repo of a fork. */
export function originRepo(run, top) {
  const r = run("git", ["remote", "get-url", "origin"], { cwd: top });
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

function ghState(run, top, branch, repo) {
  const r = run(
    "gh",
    [
      "pr",
      "list",
      ...(repo ? ["--repo", repo] : []),
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "state,headRefOid",
      "--jq",
      '.[] | .state + " " + .headRefOid',
    ],
    { cwd: top },
  );
  if (r.status !== 0) return { unavailable: true };
  const rows = r.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(" "));
  return { rows };
}

/** Processes whose command line mentions the path (best effort; null when it cannot be asked). */
export function openProcs(run, path) {
  if (process.platform === "win32") {
    const p = path.replace(/\//g, "\\").replace(/'/g, "''").toLowerCase();
    const r = run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLower().Contains('${p}') } | ForEach-Object { $_.Name }`,
    ]);
    if (r.status !== 0) return null;
    return r.stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const r = run("lsof", ["-t", "+D", path]);
  if (r.status > 1) return null; // lsof exits 1 for "nothing open"
  return r.stdout.trim().split("\n").filter(Boolean);
}

/** Decide one worktree. Returns { safe, reasons[], warnings[], pr }. */
export function assess(
  w,
  { run, top, base = "origin/main", checkProcs = true, repo = null },
) {
  const reasons = [];
  const warnings = [];
  let pr = "-";
  if (!w.branch)
    return { safe: false, reasons: ["detached HEAD"], warnings, pr };
  const git = (...a) => run("git", a, { cwd: top });

  const st = run("git", ["status", "--porcelain"], { cwd: w.path });
  if (st.status !== 0) reasons.push("git status failed");
  else if (st.stdout.trim() !== "") reasons.push("uncommitted changes");

  const up = git("rev-parse", "--abbrev-ref", `${w.branch}@{upstream}`);
  let ref = up.status === 0 ? up.stdout.trim() : "";
  if (!ref) {
    const o = git(
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${w.branch}`,
    );
    if (o.status === 0) ref = `origin/${w.branch}`;
  }
  let unpushed = null;
  if (ref) {
    const c = git("rev-list", "--count", `${ref}..${w.branch}`);
    if (c.status === 0) unpushed = Number(c.stdout.trim());
  }

  const g = ghState(run, top, w.branch, repo);
  if (g.unavailable) {
    warnings.push(
      `gh unavailable: PR check skipped, requiring ancestry in ${base}`,
    );
    pr = "unknown";
    const merged =
      git("merge-base", "--is-ancestor", w.branch, base).status === 0;
    if (!merged) reasons.push(`not merged into ${base} and PR state unknown`);
  } else if (g.rows.length === 0) {
    pr = "none";
    reasons.push("no PR for the branch");
  } else {
    const states = g.rows.map((r) => r[0]);
    pr = [...new Set(states)].join("+").toLowerCase();
    if (states.includes("OPEN")) reasons.push("PR open");
    else if (unpushed === null) {
      // A merged branch whose remote branch is gone counts as pushed when the PR head is our HEAD.
      const head = git("rev-parse", w.branch).stdout.trim();
      if (g.rows.some((r) => r[1] === head)) unpushed = 0;
    }
  }
  if (unpushed === null)
    reasons.push("no remote ref to compare (unpushed commits unknown)");
  else if (unpushed > 0) reasons.push(`${unpushed} unpushed commit(s)`);

  if (checkProcs) {
    const procs = openProcs(run, w.path);
    if (procs === null) warnings.push("process check unavailable");
    else if (procs.length)
      reasons.push(`in use by ${[...new Set(procs)].join(",")}`);
  }
  return { safe: reasons.length === 0, reasons, warnings, pr, unpushed };
}

function nodeModulesDirs(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === ".git") continue;
    const p = join(root, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (n === "node_modules") out.push(p);
    else if (st.isDirectory() && !st.isSymbolicLink())
      nodeModulesDirs(p, depth + 1, out);
  }
  return out;
}

/** Remove one assessed-safe worktree. Returns freed bytes. */
export function removeWorktree(w, { run, top }) {
  const before = dirSize(w.path);
  for (const l of findLinks(w.path)) removeLink(l, run);
  // removeTree unlinks any link it meets and descends only into real directories.
  for (const nm of nodeModulesDirs(w.path)) removeTree(nm, run);
  const r = run("git", ["worktree", "remove", w.path], { cwd: top });
  if (r.status !== 0)
    throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
  return before - (existsSync(w.path) ? dirSize(w.path) : 0);
}

export function reap({
  root,
  apply = false,
  run = realRun,
  cwd = process.cwd(),
  log = console.log,
  checkProcs = true,
  repo,
}) {
  const top = run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  }).stdout.trim();
  repo = repo ?? originRepo(run, top);
  const all = parseWorktrees(
    run("git", ["worktree", "list", "--porcelain"], { cwd: top }).stdout,
  );
  const rows = [];
  for (const w of all.slice(1)) {
    if (!under(w.path, root)) continue;
    const a = assess(w, { run, top, checkProcs, repo });
    rows.push({ w, a, size: existsSync(w.path) ? dirSize(w.path) : 0 });
  }
  const nSafe = rows.filter((r) => r.a.safe).length;
  log(
    `worktree-reap ${apply ? "APPLY" : "DRY RUN"} under ${root}: ${rows.length} worktree(s), ${nSafe} safe, ${rows.length - nSafe} keep`,
  );
  log("verdict | size | pr | branch | path | why");
  for (const { w, a, size } of rows)
    log(
      `${a.safe ? "SAFE" : "keep"} | ${fmtBytes(size)} | ${a.pr} | ${w.branch ?? "(detached)"} | ${w.path} | ${a.reasons.join("; ") || "-"}`,
    );
  for (const m of new Set(rows.flatMap((r) => r.a.warnings)))
    log(`warning: ${m}`);
  let freed = 0;
  if (apply) {
    for (const { w, a } of rows) {
      if (!a.safe) continue;
      try {
        const n = removeWorktree(w, { run, top });
        freed += n;
        log(`removed ${w.path} (freed ${fmtBytes(n)})`);
      } catch (e) {
        log(`FAILED ${w.path}: ${e.message}`);
      }
    }
    log(`freed ${fmtBytes(freed)} in total`);
  } else
    log(
      "dry run: nothing was removed. Re-run with --apply to remove the SAFE rows.",
    );
  return { rows, freed };
}

function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf("--root");
  reap({
    root: ri >= 0 ? argv[ri + 1] : "D:/temp",
    repo: argv.includes("--repo")
      ? argv[argv.indexOf("--repo") + 1]
      : undefined,
    apply: argv.includes("--apply") && !argv.includes("--dry-run"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
