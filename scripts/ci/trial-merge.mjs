// Trial merge of a PR head with the current tip of main (CI15, docs/ci-merge-gate.md section 6).
// Two PRs that were each green alone broke main together (#553 x #557, #587 x #588) because nothing
// built the merged result. This builds it: `git merge-tree --write-tree` makes the merged tree with no
// checkout, the files either side changed since the merge base pick the projects to check, and with
// `run` a temporary detached worktree of the merged commit gets the same type-check and lint
// commands as the PR checks. node_modules are linked from an existing checkout, never installed, and
// only the links are removed afterwards. Nothing in the caller's working tree or index is touched.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTree } from "./combine.mjs";

// The same commands as pr-checks.yaml (core-checks, gui-checks, binary-checks).
export const PROJECTS = [
  {
    dir: "core",
    cmds: [
      ["npx", "tsc", "--noEmit"],
      ["npm", "run", "lint"],
    ],
  },
  {
    dir: "gui",
    cmds: [
      ["npx", "tsc", "--noEmit"],
      ["npm", "run", "lint"],
    ],
  },
  { dir: "binary", cmds: [["npx", "tsc", "--noEmit"]] },
];

const IDENT = {
  GIT_AUTHOR_NAME: "trial",
  GIT_AUTHOR_EMAIL: "trial@invalid",
  GIT_COMMITTER_NAME: "trial",
  GIT_COMMITTER_EMAIL: "trial@invalid",
};

function git(cwd, args, env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const lines = (s) => s.split("\n").filter(Boolean);

/**
 * Which projects a set of changed files can break. core is imported by gui and binary, so a core
 * change checks all three; the root manifest, lockfile, tsconfig and packages/ do too. Docs-only
 * changes check nothing.
 */
export function projectsFor(files) {
  const all = PROJECTS.map((p) => p.dir);
  const hit = new Set();
  for (const f of files) {
    if (f.startsWith("core/") || f.startsWith("packages/")) return all;
    if (/^(package(-lock)?\.json|tsconfig\.json)$/.test(f)) return all;
    for (const d of all) if (f.startsWith(`${d}/`)) hit.add(d);
  }
  return all.filter((d) => hit.has(d));
}

/**
 * Merge `pr` into `main` in the object database. Returns
 * {behind, conflict, files, commit, projects}. `behind` is how many commits of main the PR lacks;
 * when 0 the PR head already contains main and nothing needs trying.
 */
export function trialPlan(cwd, main, pr) {
  const behind = Number(git(cwd, ["rev-list", "--count", `${pr}..${main}`]));
  const base = git(cwd, ["merge-base", main, pr]);
  const sides = [
    ...lines(git(cwd, ["diff", "--name-only", base, main])),
    ...lines(git(cwd, ["diff", "--name-only", base, pr])),
  ];
  const m = mergeTree(cwd, main, pr);
  if (!m.clean)
    return {
      behind,
      conflict: true,
      files: m.files,
      commit: null,
      projects: [],
    };
  const commit = git(
    cwd,
    ["commit-tree", m.tree, "-p", main, "-p", pr, "-m", "trial merge"],
    IDENT,
  );
  return {
    behind,
    conflict: false,
    files: [],
    commit,
    projects: behind === 0 ? [] : projectsFor(sides),
  };
}

function linkTargets(deps) {
  const out = [
    "node_modules",
    "core/node_modules",
    "gui/node_modules",
    "binary/node_modules",
  ];
  const pk = join(deps, "packages");
  if (existsSync(pk))
    for (const d of readdirSync(pk)) out.push(`packages/${d}/node_modules`);
  return out.filter((p) => existsSync(join(deps, p)));
}

// Remove a link without touching what it points at (junction on Windows, symlink elsewhere).
function unlink(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return;
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p);
    }
  } catch {}
}

/**
 * Check out `commit` in a temporary detached worktree, link node_modules from `deps` and run each
 * project's commands. Returns [{project, cmd, status}]; stops a project at its first failure.
 */
export function runTrial(cwd, commit, projects, deps, run = spawnSync) {
  const dir = mkdtempSync(join(tmpdir(), "trial-"));
  const wt = join(dir, "wt");
  git(cwd, ["worktree", "add", "--detach", wt, commit]);
  const links = [];
  const results = [];
  try {
    for (const rel of linkTargets(deps)) {
      const dest = join(wt, rel);
      if (!existsSync(join(wt, rel, ".."))) continue;
      symlinkSync(join(deps, rel), dest, "junction");
      links.push(dest);
    }
    for (const p of PROJECTS.filter((x) => projects.includes(x.dir))) {
      for (const [bin, ...args] of p.cmds) {
        const r = run(bin, args, {
          cwd: join(wt, p.dir),
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        results.push({
          project: p.dir,
          cmd: [bin, ...args].join(" "),
          status: r.status,
        });
        if (r.status !== 0) break;
      }
    }
  } finally {
    for (const l of links) unlink(l);
    try {
      git(cwd, ["worktree", "remove", "--force", wt]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}
