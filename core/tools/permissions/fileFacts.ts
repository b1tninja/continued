import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Two small, synchronous looks at the disk for the ask rules (ROADMAP B57,
 * B61). Both answer "unknown" (undefined) on any error, and callers treat
 * unknown as the cautious side: the file is counted as new, or the package
 * is counted as not declared.
 */

const MAX_BYTES = 8 * 1024 * 1024;

/** `uriToPath` gives `/C:/dir` on Windows; the file system wants `C:/dir`. */
const local = (p: string) => p.replace(/^\/([A-Za-z]:)/, "$1");

/** Lines in an existing regular file, or undefined when absent or unreadable. */
export function existingLineCount(
  file: string | undefined,
): number | undefined {
  if (!file) return undefined;
  try {
    const stat = fs.statSync(local(file));
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const text = fs.readFileSync(local(file), "utf8");
    return text === "" ? 0 : text.split("\n").length;
  } catch {
    return undefined;
  }
}

/** Package names that the nearest package.json above `cwd` lists, or undefined. */
export function declaredPackages(
  cwd: string | undefined,
): Set<string> | undefined {
  if (!cwd) return undefined;
  let dir = path.resolve(local(cwd));
  for (let depth = 0; depth < 64; depth++) {
    const file = path.join(dir, "package.json");
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= MAX_BYTES) {
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        const names = new Set<string>();
        for (const key of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
        ]) {
          const group = json?.[key];
          if (group && typeof group === "object" && !Array.isArray(group)) {
            for (const name of Object.keys(group)) names.add(name);
          }
        }
        return names;
      }
    } catch (e: any) {
      // An unreadable or unparsable package.json is unknown, not "empty"
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
