import type { IDE } from "../index.js";

/**
 * The IDE as seen from another checkout: `getWorkspaceDirs()` answers
 * `workspaceDirs` (URIs), and everything else reaches the real IDE. A tool
 * that resolves a relative path against the workspace, or runs a command in
 * its first folder, then works in that checkout; an absolute path is left
 * alone, as it is today. Used for `tools/call` with `workspaceDirs` set: a
 * Loop worker running an item in its own worktree (plans/loop-mode.md, L4).
 */
export function ideInWorkspace(ide: IDE, workspaceDirs: string[]): IDE {
  const dirs = [...workspaceDirs];
  return new Proxy(ide, {
    get(target, property, receiver) {
      if (property === "getWorkspaceDirs") {
        return async () => [...dirs];
      }
      const value = Reflect.get(target, property, receiver);
      // Methods keep the real IDE as `this`: its private fields live there
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
