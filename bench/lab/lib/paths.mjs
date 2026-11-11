// Where the lab may write. Nothing outside these roots is ever opened for
// writing: results and profiles under the lab, scratch under the OS temp dir.
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
  };
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Throws unless `file` is under a writable root; returns the resolved path. */
export function assertWritable(file, r = roots()) {
  const abs = path.resolve(file);
  if (![r.results, r.profiles, r.tmp].some((root) => inside(root, abs)))
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
