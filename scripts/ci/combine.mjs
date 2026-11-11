// Pairwise "does PR A conflict when merged after PR B" matrix, computed with
// `git merge-tree --write-tree` (git >= 2.38): nothing is checked out, no index or working tree
// is touched. It only writes unreferenced tree/commit objects into the object database.
import { execFileSync, spawnSync } from "node:child_process";

// Files that feature branches tend to share; two PRs sharing one must be merged serially.
export const HOT = [
  /dialect/i,
  /loadYaml\.ts$/,
  /evaluate\.ts$/,
  /extensions\/cli\/src\/index\.ts$/,
  /ROADMAP/i,
  /recovery/i,
];

const IDENT = {
  GIT_AUTHOR_NAME: "combine",
  GIT_AUTHOR_EMAIL: "combine@invalid",
  GIT_COMMITTER_NAME: "combine",
  GIT_COMMITTER_EMAIL: "combine@invalid",
};

function git(cwd, args, extraEnv = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 1 << 28,
  });
}

function must(cwd, args, extraEnv) {
  const r = git(cwd, args, extraEnv);
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Merge `other` into `base` without a checkout. Returns {clean, tree, files}. */
export function mergeTree(cwd, base, other) {
  const r = git(cwd, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    base,
    other,
  ]);
  if (r.status === 0) return { clean: true, tree: r.stdout.trim(), files: [] };
  if (r.status === 1) {
    const [tree, ...rest] = r.stdout.split("\n");
    return { clean: false, tree, files: rest.filter(Boolean) };
  }
  throw new Error(`git merge-tree failed (${r.status}): ${r.stderr}`);
}

/** A commit object for `base` + `other` (only when that merge is clean), else null. */
function mergedCommit(cwd, base, other) {
  const m = mergeTree(cwd, base, other);
  if (!m.clean) return null;
  return must(
    cwd,
    ["commit-tree", m.tree, "-p", base, "-p", other, "-m", "combine"],
    IDENT,
  );
}

export function changedFiles(cwd, main, ref) {
  const base = must(cwd, ["merge-base", main, ref]);
  return must(cwd, ["diff", "--name-only", base, ref])
    .split("\n")
    .filter(Boolean);
}

/**
 * refs: {name: gitRef}. For every pair (a, b): merge main+b first, then a on top, and report the
 * conflicting files. Also reports each ref against main alone and the shared files.
 */
export function combineMatrix(cwd, main, refs) {
  const names = Object.keys(refs);
  const alone = {};
  const files = {};
  for (const n of names) {
    alone[n] = mergeTree(cwd, main, refs[n]);
    files[n] = new Set(changedFiles(cwd, main, refs[n]));
  }
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      const shared = [...files[a]].filter((f) => files[b].has(f));
      const hot = shared.filter((f) => HOT.some((h) => h.test(f)));
      let result;
      if (!alone[a].clean || !alone[b].clean) {
        result = { status: "skipped", conflicts: [] };
      } else {
        // a after b, and b after a: report either direction that conflicts.
        const conflicts = new Set();
        for (const [first, second] of [
          [b, a],
          [a, b],
        ]) {
          const c = mergedCommit(cwd, main, refs[first]);
          const m = mergeTree(cwd, c, refs[second]);
          if (!m.clean) m.files.forEach((f) => conflicts.add(f));
        }
        result = {
          status: conflicts.size ? "conflict" : "clean",
          conflicts: [...conflicts],
        };
      }
      pairs.push({ a, b, shared, hot, ...result });
    }
  }
  return { alone, pairs };
}

export function formatMatrix({ alone, pairs }) {
  const out = ["Against main alone:"];
  for (const [n, m] of Object.entries(alone))
    out.push(
      `  ${n}: ${m.clean ? "clean" : "CONFLICT in " + m.files.join(", ")}`,
    );
  out.push("", "Pairwise (second merged after first):");
  for (const p of pairs) {
    out.push(`  ${p.a} + ${p.b}: ${p.status.toUpperCase()}`);
    if (p.conflicts.length)
      out.push(`      conflicts: ${p.conflicts.join(", ")}`);
    if (p.shared.length) out.push(`      shared files: ${p.shared.join(", ")}`);
    if (p.hot.length) out.push(`      HOT files: ${p.hot.join(", ")}`);
  }
  return out.join("\n");
}

/** Fresh fetch of main and PR heads into refs/combine/*; returns {name: ref}. No checkout. */
export function fetchPrRefs(cwd, numbers, remote = "origin") {
  const specs = ["+refs/heads/main:refs/combine/main"];
  for (const n of numbers)
    specs.push(`+refs/pull/${n}/head:refs/combine/pr-${n}`);
  execFileSync("git", ["fetch", "--no-tags", remote, ...specs], {
    cwd,
    stdio: "inherit",
  });
  return {
    main: "refs/combine/main",
    prs: Object.fromEntries(
      numbers.map((n) => [`#${n}`, `refs/combine/pr-${n}`]),
    ),
  };
}
