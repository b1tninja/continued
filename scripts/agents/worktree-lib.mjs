// Shared helpers for worktree-bootstrap.mjs and worktree-reap.mjs. Node only, no dependencies.
// Rule behind all of it: a link (symlink or Windows junction) is removed as a link and never
// followed, because a recursive delete or `npm ci` that follows a junction acts on its TARGET.
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

/** Default process runner. Tests pass a fake with the same shape. */
export function realRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    shell: Boolean(opts.shell),
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
}

/** True for symlinks and Windows junctions (lstat reports both as symbolic links). */
export function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove one link without touching what it points to. */
export function removeLink(p, run = realRun) {
  try {
    rmdirSync(p); // directory symlink or junction: removes the link only
    return;
  } catch {}
  try {
    unlinkSync(p); // file symlink, or POSIX directory symlink (rmdir gives ENOTDIR)
    return;
  } catch (e) {
    if (process.platform === "win32") {
      const r = run("cmd", ["/c", "rmdir", p.replace(/\//g, "\\")]);
      if (r.status === 0) return;
    }
    throw e;
  }
}

/** Delete a tree, unlinking every link it meets instead of descending into it. */
export function removeTree(p, run = realRun) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return removeLink(p, run);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) removeTree(join(p, name), run);
    rmdirSync(p);
  } else unlinkSync(p);
}

/** Bytes under p, counting links as themselves and never following them. */
export function dirSize(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  let n = 0;
  for (const name of readdirSync(p)) n += dirSize(join(p, name));
  return n;
}

export function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
}

export { existsSync };
