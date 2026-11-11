import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deputyTargets } from "./deputyTargets";

/**
 * Where a path a tool names really lands, for a caller that has no IDE to
 * resolve it (the CLI). Symlinks and junctions are followed; a file that does
 * not exist yet is judged by its nearest existing parent, so a new file under
 * a link that leaves the workspace is caught. Host file system, host path
 * rules: this is the one place the deputy rule touches the disk.
 */
export interface RealPath {
  uri: string;
  displayPath: string;
  isAbsolute: boolean;
  isWithinWorkspace: boolean;
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = nodePath.dirname(p);
    if (parent === p) return p;
    return nodePath.join(real(parent), nodePath.basename(p));
  }
}

function inside(child: string, root: string): boolean {
  const rel = nodePath.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

export function resolveRealPath(
  raw: string,
  cwd: string,
  home: string = os.homedir(),
  otherRoots: readonly string[] = [],
): RealPath | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let candidate = text;
  if (/^file:\/\//i.test(text)) {
    try {
      candidate = new URL(text).pathname;
      if (process.platform === "win32") candidate = candidate.slice(1);
      candidate = decodeURIComponent(candidate);
    } catch {
      return undefined;
    }
  } else if (text === "~" || /^~[\\/]/.test(text)) {
    candidate = nodePath.join(home, text.slice(1));
  }
  const abs = nodePath.resolve(cwd, candidate);
  const target = real(abs);
  const roots = [cwd, ...otherRoots].map((r) => real(nodePath.resolve(r)));
  const fold = (s: string) =>
    process.platform === "win32" ? s.toLowerCase() : s;
  return {
    uri: pathToFileURL(target).href,
    displayPath: raw,
    isAbsolute: nodePath.isAbsolute(candidate),
    isWithinWorkspace: roots.some((r) => inside(fold(target), fold(r))),
  };
}

/**
 * `processedArgs` for a built-in file, list or search call: what the IDE's
 * `preprocessArgs` would put there. Undefined for a call that names no path.
 */
export function processedPathArgs(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  cwd: string,
): { resolvedPath: RealPath } | undefined {
  const targets = deputyTargets(toolName, parsedArgs, false);
  if (!targets?.single || targets.paths.length !== 1) return undefined;
  const resolved = resolveRealPath(targets.paths[0], cwd);
  return resolved ? { resolvedPath: resolved } : undefined;
}

/**
 * The link-following resolver for MCP path arguments (deputyCall `resolvePath`),
 * for a host whose workspace folders are local paths. Undefined when there are
 * none, so a remote workspace is judged as written.
 */
export function localLinkResolver(
  workspaceDirs: readonly string[],
  home: string = os.homedir(),
):
  | ((raw: string) => { path: string; withinWorkspace: boolean } | undefined)
  | undefined {
  const [first, ...rest] = workspaceDirs;
  if (!first) return undefined;
  return (raw) => {
    const r = resolveRealPath(raw, first, home, rest);
    return r
      ? { path: fileURLToPath(r.uri), withinWorkspace: r.isWithinWorkspace }
      : undefined;
  };
}
