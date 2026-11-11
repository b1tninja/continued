#!/usr/bin/env node
// Local guard for the ".gitignore swallowed a source directory" trap (bench/research/lib,
// bench/lab/lib): a generic rule such as `lib/` silently keeps new source files out of `git add`,
// so the PR is green locally and broken in CI. Run before pushing:
//   node scripts/ci/check-ignored.mjs
// It lists ignored directories that contain source files and are not a known build/cache output.
// It can only see your working tree (CI checkouts never contain ignored files), so it is a
// developer-side check, not a CI step.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE = /\.(ts|tsx|js|mjs|cjs|py|json|yaml|yml|md)$/;
const KNOWN =
  /(^|\/)(node_modules|dist|out|build|coverage|target|\.cache|\.vite|__pycache__|\.venv|venv|bin|tmp)(\/|$)/;

const out = execFileSync(
  "git",
  ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
  { encoding: "utf8", maxBuffer: 1 << 28 },
);

function hasSource(dir, depth = 0) {
  if (depth > 4) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && SOURCE.test(e.name)) return true;
    if (
      e.isDirectory() &&
      e.name !== "node_modules" &&
      hasSource(join(dir, e.name), depth + 1)
    )
      return true;
  }
  return false;
}

const suspects = out
  .split("\n")
  .filter((p) => p.endsWith("/") && !KNOWN.test(p))
  .filter((p) => hasSource(p));

if (suspects.length) {
  console.error(
    "Ignored directories that contain source files (add a `!path/` rule or force-add):",
  );
  for (const s of suspects) {
    const why = execFileSync("git", ["check-ignore", "-v", s], {
      encoding: "utf8",
    }).trim();
    console.error(`  ${s}  <- ${why}`);
  }
  process.exit(1);
}
console.log("No ignored source directories.");
