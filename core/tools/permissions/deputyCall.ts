import * as os from "node:os";
import { builtinRuleOn, type BuiltinRuleId } from "./policy";
import type { ProtectedHit } from "./protected";
import { fileToolTarget } from "./protectedCall";
import {
  deputyPathHit,
  hostFlavor,
  type DeputyHit,
  type PathFlavor,
} from "./deputyPaths";
import { globalDirsFor } from "./selfProtect";

export interface DeputyCallInput {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** What the tool resolved: the real path and whether it is in a workspace folder. */
  resolved?: { path?: string; withinWorkspace?: boolean };
  cwd?: string;
  approval?: { builtin?: Partial<Record<BuiltinRuleId, boolean>> };
  flavor?: PathFlavor;
  home?: string;
}

/**
 * The confused-deputy check for one tool call (deputyPaths.ts): the built-in
 * file tools only. Switchable by the person's own `builtin` settings and by
 * nothing else: `ask-outside-paths` for a path outside the workspace or in
 * another account's home, `protect-network-paths` for a UNC path. A device
 * path, an alternate data stream and the global configuration folder have no
 * switch.
 */
export function deputyCallHit(
  input: DeputyCallInput,
): ProtectedHit | undefined {
  const target = fileToolTarget(input.toolName, input.parsedArgs);
  // read_currently_open_file names no path: judge the one it resolved.
  const raw = target?.path ?? (target ? input.resolved?.path : undefined);
  if (!raw) return undefined;
  const home = input.home ?? os.homedir();
  const hit: DeputyHit | undefined = deputyPathHit({
    raw,
    resolved: input.resolved?.path,
    withinWorkspace: input.resolved?.withinWorkspace,
    flavor: input.flavor ?? hostFlavor(),
    home,
    cwd: input.cwd,
    globalDirs: globalDirsFor(home),
  });
  if (!hit) return undefined;
  const on = (id: BuiltinRuleId) => builtinRuleOn(input.approval as never, id);
  if (hit.why === "network" && !on("protect-network-paths")) return undefined;
  if (
    (hit.why === "outside-workspace" || hit.why === "other-account") &&
    !on("ask-outside-paths")
  ) {
    return undefined;
  }
  return { kind: hit.kind, path: hit.path };
}
