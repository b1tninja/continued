import { exec, execFile } from "child_process";
import * as nodeFs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { getContinueGlobalPath } from "./paths.js";
import { terminalEnvironment } from "./terminalEnvironment.js";

/**
 * Git worktrees for Loop mode's parallel items (plans/loop-mode.md, "Next:
 * parallel items as subagents", step P2). Each worker runs in a worktree of
 * its own on a `continued/loop-<slug>-<itemId>` branch cut from HEAD plus the
 * main checkout's uncommitted state; its work comes back as a patch from the
 * baseline, which the parent applies to the main checkout one at a time, or
 * refuses. Nothing here runs git itself: the caller injects a runner (the CLI
 * `execFile`, the IDE `ide.subprocess`), so the module is shared by both.
 */

/** Runs `git <args>` in `cwd`; resolves with stdout, rejects with stderr on a non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Runs a shell command in `cwd` (the `.continue/worktrees.json` setup commands). */
export type ShellRunner = (
  command: string,
  cwd: string,
  env: Record<string, string>,
) => Promise<string>;

/** The few file operations the helper needs; node's `fs/promises` by default. */
export interface WorktreeFs {
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rm(target: string): Promise<void>;
  exists(target: string): Promise<boolean>;
}

export const defaultWorktreeFs: WorktreeFs = {
  readFile: (file) => nodeFs.readFile(file, "utf8"),
  writeFile: (file, data) => nodeFs.writeFile(file, data),
  copyFile: (src, dest) => nodeFs.copyFile(src, dest),
  mkdir: async (dir) => {
    await nodeFs.mkdir(dir, { recursive: true });
  },
  rm: (target) => nodeFs.rm(target, { recursive: true, force: true }),
  exists: async (target) => {
    try {
      await nodeFs.access(target);
      return true;
    } catch {
      return false;
    }
  },
};

const MAX_BUFFER = 64 * 1024 * 1024;

export const defaultShellRunner: ShellRunner = (command, cwd, env) =>
  new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, env: { ...terminalEnvironment(), ...env }, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });

/** The git runner for a Node host (the IDE's core): `git` on the PATH. */
export const execFileGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.toString().trim() || error.message));
        } else {
          resolve(stdout.toString());
        }
      },
    );
  });

export const LOOP_BRANCH_PREFIX = "continued/loop-";

/** The keys of `.continue/worktrees.json`, as Cursor's file has them. */
export const WORKTREES_CONFIG_PATH = path.join(".continue", "worktrees.json");
export const ROOT_WORKTREE_VAR = "ROOT_WORKTREE_PATH";

export interface WorktreeInfo {
  /** The worktree's directory. */
  path: string;
  /** The branch checked out there, `continued/loop-<slug>-<itemId>`. */
  branch: string;
  /** The baseline commit: HEAD plus the main checkout's uncommitted state. */
  baseline: string;
}

export interface WorktreeDeps {
  git: GitRunner;
  fs?: WorktreeFs;
  shell?: ShellRunner;
}

export interface CreateItemWorktreeOptions {
  /** The main checkout. */
  repo: string;
  /** The plan's slug; part of the branch and folder names. */
  slug: string;
  /** The item's id; part of the branch and folder names. */
  itemId: string;
  /** Where worktrees live; `<global dir>/worktrees` by default. */
  root?: string;
}

/** `~/.continuous/worktrees` (or the configured global dir): the default root. */
export function defaultWorktreeRoot(): string {
  return path.join(getContinueGlobalPath(), "worktrees");
}

/** A string safe inside a branch name and a folder name. */
function refPart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\s~^:?*[\]\\/@{}"'`<>|]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "item";
}

export function loopBranchName(slug: string, itemId: string): string {
  return `${LOOP_BRANCH_PREFIX}${refPart(slug)}-${refPart(itemId)}`;
}

/** `git diff` and friends print paths with forward slashes; status may quote them. */
function normalizeRepoPath(file: string): string {
  let p = file.trim().replace(/\\/g, "/");
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

/**
 * The files a patch touches, read from its `diff --git a/<old> b/<new>`
 * headers (both sides, so a rename counts for its old and its new name).
 */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = header.exec(patch)) !== null) {
    files.add(normalizeRepoPath(m[1]));
    files.add(normalizeRepoPath(m[2]));
  }
  return [...files];
}

let patchFileCounter = 0;

/** The runner has no stdin, so a patch goes through a temp file. */
async function withPatchFile<T>(
  fs: WorktreeFs,
  patch: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  patchFileCounter += 1;
  const file = path.join(
    os.tmpdir(),
    `continued-loop-${process.pid}-${Date.now()}-${patchFileCounter}.patch`,
  );
  await fs.writeFile(file, patch);
  try {
    return await fn(file);
  } finally {
    await fs.rm(file).catch(() => undefined);
  }
}

const IDENTITY_ARGS = [
  "-c",
  "user.name=Continued loop",
  "-c",
  "user.email=loop@continued.invalid",
  "-c",
  "commit.gpgsign=false",
];

interface WorktreesConfig {
  "setup-worktree"?: string[] | string;
  "setup-worktree-unix"?: string[] | string;
  "setup-worktree-windows"?: string[] | string;
}

/** The setup commands for this platform, `$ROOT_WORKTREE_PATH` substituted. */
export function setupCommands(
  config: WorktreesConfig,
  rootWorktreePath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const specific =
    platform === "win32"
      ? config["setup-worktree-windows"]
      : config["setup-worktree-unix"];
  const chosen = specific ?? config["setup-worktree"];
  const list =
    chosen === undefined ? [] : Array.isArray(chosen) ? chosen : [chosen];
  return list
    .filter((c): c is string => typeof c === "string" && c.trim() !== "")
    .map((c) =>
      c.replace(
        new RegExp(`\\$\\{?${ROOT_WORKTREE_VAR}\\}?`, "g"),
        rootWorktreePath,
      ),
    );
}

async function runSetup(
  deps: WorktreeDeps,
  repo: string,
  worktree: string,
): Promise<void> {
  const fs = deps.fs ?? defaultWorktreeFs;
  const configFile = path.join(repo, WORKTREES_CONFIG_PATH);
  if (!(await fs.exists(configFile))) {
    return;
  }
  let config: WorktreesConfig;
  try {
    config = JSON.parse(await fs.readFile(configFile)) as WorktreesConfig;
  } catch (e) {
    throw new Error(
      `${WORKTREES_CONFIG_PATH} is not valid JSON: ${(e as Error).message}`,
    );
  }
  const shell = deps.shell ?? defaultShellRunner;
  for (const command of setupCommands(config, repo)) {
    await shell(command, worktree, { [ROOT_WORKTREE_VAR]: repo });
  }
}

/**
 * A worktree for one item: a new branch from HEAD, the main checkout's
 * uncommitted diff applied (binary included) and its untracked, non-ignored
 * files copied, a baseline commit, then the repository's setup commands. The
 * main checkout itself is not touched. A failure after the worktree exists
 * removes it again before the error is rethrown.
 */
export async function createItemWorktree(
  options: CreateItemWorktreeOptions,
  deps: WorktreeDeps,
): Promise<WorktreeInfo> {
  const { git } = deps;
  const fs = deps.fs ?? defaultWorktreeFs;
  const repo = path.resolve(options.repo);
  const root = options.root ?? defaultWorktreeRoot();
  const branch = loopBranchName(options.slug, options.itemId);
  const dir = path.join(
    root,
    path.basename(repo),
    `${refPart(options.slug)}-${refPart(options.itemId)}`,
  );

  await fs.mkdir(path.dirname(dir));
  await git(["worktree", "add", "-b", branch, dir, "HEAD"], repo);

  try {
    const dirty = await git(["diff", "--binary", "HEAD"], repo);
    if (dirty.trim() !== "") {
      await withPatchFile(fs, dirty, (file) =>
        git(["apply", "--whitespace=nowarn", file], dir),
      );
    }

    const untracked = await git(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      repo,
    );
    for (const rel of untracked.split("\0").filter((f) => f !== "")) {
      const dest = path.join(dir, rel);
      await fs.mkdir(path.dirname(dest));
      await fs.copyFile(path.join(repo, rel), dest);
    }

    await git(["add", "-A"], dir);
    await git(
      [
        ...IDENTITY_ARGS,
        "commit",
        "--allow-empty",
        "--no-verify",
        "-q",
        "-m",
        `loop: baseline for ${options.itemId} (HEAD plus the uncommitted state of ${path.basename(repo)})`,
      ],
      dir,
    );
    const baseline = (await git(["rev-parse", "HEAD"], dir)).trim();

    await runSetup(deps, repo, dir);

    return { path: dir, branch, baseline };
  } catch (e) {
    await removeWorktree(
      repo,
      { path: dir, branch },
      { deleteBranch: true },
      deps,
    ).catch(() => undefined);
    throw e;
  }
}

/**
 * Everything the worker changed since the baseline, as a patch (binary
 * included) that `applyPatch` takes. New files are staged first so they show.
 * An empty string means no changes. Errors are thrown, never swallowed.
 */
export async function worktreePatch(
  worktree: Pick<WorktreeInfo, "path" | "baseline">,
  deps: Pick<WorktreeDeps, "git">,
): Promise<string> {
  await deps.git(["add", "-A"], worktree.path);
  return deps.git(
    ["diff", "--binary", "--cached", worktree.baseline],
    worktree.path,
  );
}

export type ApplyPatchResult =
  | { applied: true; files: string[] }
  | {
      applied: false;
      /** "touched": the person changed one of the files meanwhile; "conflict": `git apply --check` failed. */
      reason: "touched" | "conflict";
      files: string[];
      message: string;
    };

export interface ApplyPatchOptions {
  /**
   * Files the person changed in the main checkout since the wave started
   * (the caller compares `dirtyFiles` at wave start and now). A patch that
   * touches one is refused.
   */
  touchedSince?: Iterable<string>;
}

/**
 * Apply a worker's patch to the main checkout: `git apply --check` first, then
 * the apply, never a three-way merge. A refusal is a result, not an exception;
 * only the runner's own failures (git missing, the repo gone) throw.
 */
export async function applyPatch(
  repo: string,
  patch: string,
  options: ApplyPatchOptions,
  deps: WorktreeDeps,
): Promise<ApplyPatchResult> {
  const fs = deps.fs ?? defaultWorktreeFs;
  const files = patchFiles(patch);
  if (patch.trim() === "") {
    return { applied: true, files };
  }

  const touched = new Set(
    [...(options.touchedSince ?? [])].map(normalizeRepoPath),
  );
  const overlap = files.filter((f) => touched.has(f));
  if (overlap.length > 0) {
    return {
      applied: false,
      reason: "touched",
      files: overlap,
      message: `changed in the main checkout since the wave started: ${overlap.join(", ")}`,
    };
  }

  return withPatchFile(fs, patch, async (file) => {
    try {
      await deps.git(["apply", "--check", "--whitespace=nowarn", file], repo);
    } catch (e) {
      return {
        applied: false,
        reason: "conflict",
        files,
        message: (e as Error).message.trim() || "git apply --check failed",
      };
    }
    await deps.git(["apply", "--whitespace=nowarn", file], repo);
    return { applied: true, files };
  });
}

/** The paths `git status --porcelain` lists: what is uncommitted in the checkout right now. */
export async function dirtyFiles(
  repo: string,
  deps: Pick<WorktreeDeps, "git">,
): Promise<string[]> {
  const out = await deps.git(
    ["status", "--porcelain", "--untracked-files=all", "-z"],
    repo,
  );
  const files: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    files.push(normalizeRepoPath(entry.slice(3)));
    if (status[0] === "R" || status[0] === "C") {
      // The next NUL-separated entry is the original name.
      i += 1;
      if (entries[i]) {
        files.push(normalizeRepoPath(entries[i]));
      }
    }
  }
  return files;
}

/** `git worktree remove --force`, a prune, and the branch deleted when asked. */
export async function removeWorktree(
  repo: string,
  worktree: Pick<WorktreeInfo, "path" | "branch">,
  options: { deleteBranch: boolean },
  deps: WorktreeDeps,
): Promise<void> {
  const fs = deps.fs ?? defaultWorktreeFs;
  try {
    await deps.git(["worktree", "remove", "--force", worktree.path], repo);
  } catch (e) {
    // The directory may be gone already; prune below registers that.
    if (await fs.exists(worktree.path)) {
      throw e;
    }
  }
  await deps.git(["worktree", "prune"], repo);
  if (options.deleteBranch) {
    await deps.git(["branch", "-D", worktree.branch], repo);
  }
}

/**
 * What an earlier wave left for this item (a reload or a crash mid-wave: the
 * loop comes back stopped and nothing removes its worktrees): the worktree on
 * the item's branch, or the branch alone when its folder is gone. Removed, so
 * `createItemWorktree` can make the item's branch again. True when there was
 * something to remove.
 */
export async function removeStaleItemWorktree(
  repo: string,
  slug: string,
  itemId: string,
  deps: WorktreeDeps,
): Promise<boolean> {
  const branch = loopBranchName(slug, itemId);
  const stale = (await listLoopWorktrees(repo, deps)).find(
    (w) => w.branch === branch,
  );
  if (stale) {
    await removeWorktree(
      repo,
      { path: stale.path, branch },
      { deleteBranch: true },
      deps,
    );
    return true;
  }
  await deps.git(["worktree", "prune"], repo);
  try {
    await deps.git(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
    );
  } catch {
    return false;
  }
  await deps.git(["branch", "-D", branch], repo);
  return true;
}

export interface LoopWorktree {
  path: string;
  branch: string;
  head: string;
}

/** The `continued/loop-*` worktrees registered in the repository, for cleanup. */
export async function listLoopWorktrees(
  repo: string,
  deps: Pick<WorktreeDeps, "git">,
): Promise<LoopWorktree[]> {
  const out = await deps.git(["worktree", "list", "--porcelain"], repo);
  const found: LoopWorktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    let wtPath: string | undefined;
    let head = "";
    let branch: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    if (wtPath && branch && branch.startsWith(LOOP_BRANCH_PREFIX)) {
      found.push({ path: wtPath, branch, head });
    }
  }
  return found;
}
