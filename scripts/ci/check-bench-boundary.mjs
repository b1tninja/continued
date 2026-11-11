#!/usr/bin/env node
// The product must never import the dev-only lab (MR7a). Fails when a source file
// under core/, gui/, extensions/, binary/ or packages/ imports, requires or
// dynamically imports something that resolves into bench/ (a relative path or a
// bare "bench/..." or the bench packages' names).
//   node scripts/ci/check-bench-boundary.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCT_DIRS = ["core", "gui", "extensions", "binary", "packages"];
const SKIP = new Set([
  "node_modules",
  "out",
  "dist",
  "build",
  "target",
  ".git",
  ".gradle",
  "coverage",
]);
const EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const BENCH_PACKAGES = /^@b1tninja\/continuous-(?:bench|local-lab)(?:\/|$)/;

/** Whether `spec`, written in `file`, reaches into bench/ of the repository at `root`. */
export function reachesBench(spec, file, root) {
  if (BENCH_PACKAGES.test(spec)) return true;
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    const target = path.resolve(path.dirname(file), spec);
    const rel = path.relative(path.join(root, "bench"), target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }
  return /^bench(?:\/|$)/.test(spec);
}

/** Violations in one file's text: [{file, line, spec}]. */
export function scanSource(text, file, root) {
  const out = [];
  for (const m of text.matchAll(SPEC)) {
    if (reachesBench(m[1], file, root)) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ file: path.relative(root, file), line, spec: m[1] });
    }
  }
  return out;
}

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) yield* sources(path.join(dir, e.name));
    } else if (EXT.test(e.name)) yield path.join(dir, e.name);
  }
}

export function findViolations(root, dirs = PRODUCT_DIRS) {
  const out = [];
  for (const d of dirs) {
    const base = path.join(root, d);
    if (!fs.existsSync(base)) continue;
    for (const f of sources(base))
      out.push(...scanSource(fs.readFileSync(f, "utf8"), f, root));
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const bad = findViolations(root);
  for (const v of bad)
    console.error(
      `${v.file}:${v.line} imports ${v.spec} (the product must not import bench/)`,
    );
  console.log(
    bad.length
      ? `${bad.length} import(s) of bench/ from the product`
      : `ok: nothing under ${PRODUCT_DIRS.join(", ")} imports bench/`,
  );
  process.exit(bad.length ? 1 : 0);
}
