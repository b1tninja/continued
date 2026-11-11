// Where the lab may write. Nothing outside these roots is ever opened for
// writing: results and profiles under the lab, scratch under the OS temp dir,
// server logs, and any root the owner names explicitly (--allow-root or
// LAB_ALLOW_ROOTS, e.g. M:\ai\lab). A root is never implied by a path the
// run merely mentions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function roots(overrides = {}) {
  return {
    results: path.resolve(
      overrides.results ??
        process.env.LAB_RESULTS ??
        path.join(LAB_ROOT, "results"),
    ),
    profiles: path.resolve(
      overrides.profiles ??
        process.env.LAB_PROFILES ??
        path.join(LAB_ROOT, "profiles"),
    ),
    tmp: path.resolve(
      overrides.tmp ?? path.join(os.tmpdir(), "continuous-lab"),
    ),
    logs: path.resolve(
      overrides.logs ??
        process.env.LAB_LOGS ??
        path.join(LAB_ROOT, "results", "logs"),
    ),
    allow: [
      ...(overrides.allow ?? []),
      ...(process.env.LAB_ALLOW_ROOTS ?? "")
        .split(path.delimiter)
        .filter(Boolean),
    ].map((p) => path.resolve(p)),
  };
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Throws unless `file` is under a writable root; returns the resolved path. */
export function assertWritable(file, r = roots()) {
  const abs = path.resolve(file);
  const allowed = [r.results, r.profiles, r.tmp, r.logs, ...(r.allow ?? [])];
  if (!allowed.some((root) => root && inside(root, abs)))
    throw new Error(`refusing to write outside the lab's folders: ${abs}`);
  return abs;
}

export function writeText(file, text, r) {
  const abs = assertWritable(file, r);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

export function appendLine(file, line, r) {
  const abs = assertWritable(file, r);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, line + "\n");
}

export const slug = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
