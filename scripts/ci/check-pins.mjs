#!/usr/bin/env node
// Supply-chain pin policy (docs/supply-chain.md). Plain Node, no install.
// Fails when a dev-only folder or an added package depends on a range instead of an exact version,
// when a dev-only folder that has dependencies has no lockfile with integrity hashes, or when a
// zero-dependency folder gains one. Existing monorepo ranges are deliberately not checked.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Folders under the exact-version policy, and whether they must stay free of dependencies.
export const DEV_ONLY = [
  { dir: "bench", maxDeps: 0 },
  { dir: "bench/research", maxDeps: 0 },
  { dir: "bench/lab", maxDeps: 0 },
  { dir: "bench/screenshots", maxDeps: Infinity },
];

// Packages that, wherever they appear in any package.json, must be exact (W-D2).
export const ALWAYS_EXACT = ["@anthropic-ai/sandbox-runtime"];

const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isExact(spec) {
  return EXACT.test(spec);
}

function depsOf(pkg) {
  const out = [];
  for (const key of DEP_KEYS)
    for (const [name, spec] of Object.entries(pkg[key] ?? {}))
      out.push({ key, name, spec });
  return out;
}

export function checkPackage(pkg, { enforceAll, maxDeps = Infinity }) {
  const problems = [];
  const deps = depsOf(pkg);
  if (deps.length > maxDeps)
    problems.push(
      `has ${deps.length} dependencies, expected at most ${maxDeps}: ${deps.map((d) => d.name).join(", ")}`,
    );
  for (const d of deps) {
    if ((enforceAll || ALWAYS_EXACT.includes(d.name)) && !isExact(d.spec))
      problems.push(
        `${d.key}.${d.name} is "${d.spec}", expected an exact version`,
      );
  }
  return problems;
}

export function checkLockfile(dir, pkg, root) {
  if (depsOf(pkg).length === 0) return [];
  const p = join(root, dir, "package-lock.json");
  if (!existsSync(p)) return ["has dependencies but no package-lock.json"];
  const lock = JSON.parse(readFileSync(p, "utf8"));
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.link) continue;
    if (!entry.integrity)
      problems.push(`lockfile entry ${path} has no integrity hash`);
  }
  return problems;
}

function* packageJsons(root) {
  const skip = new Set(["node_modules", ".git", "out", "dist", "build"]);
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(join(rel, e.name));
      } else if (e.name === "package.json") yield join(rel, e.name);
    }
  }
}

export function run(root = process.cwd()) {
  const failures = [];
  for (const { dir, maxDeps } of DEV_ONLY) {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const m of [
      ...checkPackage(pkg, { enforceAll: true, maxDeps }),
      ...checkLockfile(dir, pkg, root),
    ])
      failures.push(`${dir}/package.json: ${m}`);
  }
  for (const rel of packageJsons(root)) {
    const pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
    for (const m of checkPackage(pkg, { enforceAll: false }))
      failures.push(`${rel.replaceAll("\\", "/")}: ${m}`);
  }
  return failures;
}

if (process.argv[1]?.endsWith("check-pins.mjs")) {
  const failures = run();
  if (failures.length) {
    console.error(`check-pins: ${failures.length} problem(s)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("check-pins: ok");
}
