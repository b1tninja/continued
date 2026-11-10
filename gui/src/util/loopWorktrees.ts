import type { FromWebviewProtocol } from "core/protocol";
import type { WorktreeInfo } from "core/util/worktree";
import type { IIdeMessenger } from "../context/IdeMessenger";

/**
 * A file URI for a local path, in the gui (core's localPathToUri needs
 * Node's url module). A Windows drive path gets the extra slash.
 */
export function localPathUri(path: string): string {
  if (path.startsWith("file://")) return path;
  const posix = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(posix)
    ? `file:///${encodeURI(posix)}`
    : `file://${encodeURI(posix)}`;
}

/**
 * The worktrees of Loop mode's parallel waves (plans/loop-mode.md, L4):
 * each worker of a wave runs in its own copy of the repository, and its
 * changes come back as a patch the harness applies to the person's checkout.
 * The work is core's (`core/util/worktree.ts`, step P2), reached through the
 * `loop/worktree*` messages; this is the seam the tests fake
 * (`setLoopWorktreeOps`).
 */
export interface LoopWorktreeOps {
  /**
   * A worktree from HEAD plus the checkout's uncommitted changes and
   * untracked files, with a baseline commit so `patch` sees only what the
   * worker did.
   */
  create(
    messenger: IIdeMessenger,
    repo: string,
    slug: string,
    itemId: string,
  ): Promise<WorktreeInfo>;
  /** What the worker changed in its worktree, as a patch (binary included). */
  patch(
    messenger: IIdeMessenger,
    worktree: Pick<WorktreeInfo, "path" | "baseline">,
  ): Promise<string>;
  /**
   * Apply a worker's patch to the checkout: a clean apply, or a refusal
   * with the reason (a conflict, or a file the person changed since the
   * wave started). No three-way merge; nothing is resolved by hand.
   */
  apply(
    messenger: IIdeMessenger,
    repo: string,
    patch: string,
    touchedSince: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(
    messenger: IIdeMessenger,
    repo: string,
    worktree: Pick<WorktreeInfo, "path" | "branch">,
  ): Promise<void>;
  /** The files uncommitted in the checkout now (for `touchedSince`). */
  dirty(messenger: IIdeMessenger, repo: string): Promise<string[]>;
}

async function ask<T extends keyof FromWebviewProtocol>(
  messenger: IIdeMessenger,
  type: T,
  data: FromWebviewProtocol[T][0],
): Promise<FromWebviewProtocol[T][1]> {
  const result = await messenger.request(type, data);
  if (result.status === "error") throw new Error(result.error);
  return result.content;
}

export const coreLoopWorktreeOps: LoopWorktreeOps = {
  create: (messenger, repo, slug, itemId) =>
    ask(messenger, "loop/worktreeCreate", { repo, slug, itemId }),
  patch: (messenger, { path, baseline }) =>
    ask(messenger, "loop/worktreePatch", { path, baseline }),
  async apply(messenger, repo, patch, touchedSince) {
    const result = await ask(messenger, "loop/worktreeApply", {
      repo,
      patch,
      touchedSince,
    });
    return result.applied
      ? { ok: true }
      : { ok: false, reason: result.message };
  },
  remove: (messenger, repo, { path, branch }) =>
    ask(messenger, "loop/worktreeRemove", { repo, path, branch }),
  dirty: (messenger, repo) => ask(messenger, "loop/dirtyFiles", { repo }),
};

let current: LoopWorktreeOps = coreLoopWorktreeOps;

/** The operations the loop uses (tests fake them); undefined restores core's. */
export function setLoopWorktreeOps(ops?: LoopWorktreeOps): void {
  current = ops ?? coreLoopWorktreeOps;
}

export function loopWorktreeOps(): LoopWorktreeOps {
  return current;
}
