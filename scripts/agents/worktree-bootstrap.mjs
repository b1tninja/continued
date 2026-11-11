#!/usr/bin/env node
// Install only the package sets an agent needs into ONE worktree, with `npm ci --ignore-scripts`.
//   node scripts/agents/worktree-bootstrap.mjs <worktree> [--only root|core|gui|cli|packages ...]
//                                              [--cache <dir>]
// - never installs through a junction or symlink: a target whose node_modules (or set directory)
//   is a link is refused, because `npm ci` there empties the link's TARGET (another worktree);
// - uses npm's shared cache (the default one, or --cache), so a second worktree is a copy from
//   cache, not a download;
// - after the install, checks prettier and eslint against package-lock.json and prints the disk
//   used. Delete node_modules when the work is done (see scripts/agents/README.md).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dirSize, fmtBytes, isLink, realRun } from "./worktree-lib.mjs";

const NAMED = {
  root: ["."],
  core: ["core"],
  gui: ["gui"],
  cli: ["extensions/cli"],
};
const TOOLS = ["prettier", "eslint"];

/** Directories (relative to the worktree) that `--only` names; `packages` is every packages/* with a lock. */
export function resolveSets(wt, only) {
  const names = only.length ? only : ["root"];
  const dirs = [];
  for (const n of names) {
    if (n === "packages") {
      const base = join(wt, "packages");
      const found = existsSync(base)
        ? readdirSync(base)
            .filter((d) => existsSync(join(base, d, "package-lock.json")))
            .sort()
        : [];
      for (const d of found) dirs.push(`packages/${d}`);
    } else if (NAMED[n]) dirs.push(...NAMED[n]);
    else
      throw new Error(
        `unknown set "${n}" (use root, core, gui, cli, packages)`,
      );
  }
  return dirs;
}

/** Version of a package pinned in a lockfile, or null. */
export function lockedVersion(lockPath, name) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    return lock.packages?.[`node_modules/${name}`]?.version ?? null;
  } catch {
    return null;
  }
}

function installedVersion(dir, name) {
  try {
    return JSON.parse(
      readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

/** Refusal reason when installing into a set would go through a link, else null. */
export function linkRefusal(wt, rel) {
  const dir = rel === "." ? wt : join(wt, rel);
  for (const p of [wt, dir, join(dir, "node_modules")]) {
    if (isLink(p))
      return `${p} is a symlink/junction: npm ci through it would empty its target. Remove the link only (rmdir, never a recursive delete) and run again.`;
  }
  return null;
}

export function bootstrap(
  wt,
  only,
  { run = realRun, cache, log = console.log } = {},
) {
  const problems = [];
  const dirs = resolveSets(wt, only);
  let total = 0;
  for (const rel of dirs) {
    const dir = rel === "." ? wt : join(wt, rel);
    const refusal = linkRefusal(wt, rel);
    if (refusal) {
      log(`REFUSED ${rel}: ${refusal}`);
      problems.push(`${rel}: refused (link)`);
      continue;
    }
    if (!existsSync(join(dir, "package-lock.json"))) {
      log(`SKIP ${rel}: no package-lock.json`);
      continue;
    }
    const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    if (cache) args.push("--cache", cache);
    log(`npm ${args.join(" ")}  (${rel})`);
    const r = run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: dir,
      shell: process.platform === "win32",
    });
    if (r.status !== 0) {
      log(
        `FAILED ${rel}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`,
      );
      problems.push(`${rel}: npm ci failed`);
      continue;
    }
    for (const t of TOOLS) {
      const want = lockedVersion(join(dir, "package-lock.json"), t);
      if (!want) continue;
      const got = installedVersion(dir, t);
      if (got === want) log(`  ok   ${t} ${got} matches package-lock`);
      else {
        log(
          `  FAIL ${t} installed ${got ?? "missing"}, package-lock has ${want}`,
        );
        problems.push(`${rel}: ${t} ${got ?? "missing"} != ${want}`);
      }
    }
    const used = dirSize(join(dir, "node_modules"));
    total += used;
    log(`  disk ${rel}/node_modules: ${fmtBytes(used)}`);
  }
  log(
    `disk used by this install: ${fmtBytes(total)}. Delete node_modules when you are done.`,
  );
  return { ok: problems.length === 0, problems, bytes: total };
}

function main() {
  const argv = process.argv.slice(2);
  const only = [];
  let wt = null;
  let cache;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) only.push(argv[++i]);
    } else if (argv[i] === "--cache") cache = argv[++i];
    else if (!wt) wt = argv[i];
  }
  if (!wt || !existsSync(wt) || !statSync(wt).isDirectory()) {
    console.error(
      "usage: worktree-bootstrap.mjs <worktree> [--only root|core|gui|cli|packages ...] [--cache <dir>]",
    );
    process.exit(2);
  }
  const res = bootstrap(resolve(wt), only, { cache });
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
