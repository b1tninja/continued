/**
 * The workers of a Loop parallel wave that are live in this window, by item
 * id: their abort controllers, for the inbox row's Stop, the loop's Stop and
 * "Stop now". Nothing here is serialized; after a reload the loop comes
 * back stopped (restoreLoop) and the worktrees are left for the person.
 */
const workers = new Map<string, AbortController>();

export const WORKER_STOPPED_BY_USER = "Stopped by the user";
export const WORKERS_STOPPED_WITH_LOOP = "The loop was stopped";

export function registerLoopWorker(
  itemId: string,
  controller: AbortController,
): () => void {
  workers.set(itemId, controller);
  return () => {
    if (workers.get(itemId) === controller) workers.delete(itemId);
  };
}

/** The row's Stop: ends one worker; the item's run ends without its report. */
export function stopLoopWorker(itemId: string): boolean {
  const controller = workers.get(itemId);
  if (!controller) return false;
  controller.abort(new Error(WORKER_STOPPED_BY_USER));
  return true;
}

/** The loop's Stop and "Stop now": every worker ends. */
export function abortLoopWorkers(reason = WORKERS_STOPPED_WITH_LOOP): number {
  let count = 0;
  for (const controller of workers.values()) {
    controller.abort(new Error(reason));
    count++;
  }
  return count;
}

export function isLoopWorkerLive(itemId: string): boolean {
  return workers.has(itemId);
}

export function liveLoopWorkers(): string[] {
  return [...workers.keys()];
}
