/**
 * `continuous terminal-env show`: the policy for the environment commands
 * inherit, where it comes from, and the NAMES (never values) of the variables
 * it removes from this process's environment.
 */

import {
  getTerminalEnvironmentStatus,
  previewTerminalEnvironment,
  resolveTerminalSettings,
} from "core/util/terminalEnvironment.js";
import { readUserTerminalSettings } from "core/util/userTerminalSettings.js";

const SOURCES = {
  env: "the CONTINUE_TERMINAL_ENV environment variable",
  "user-config": "your config.yaml",
  "assistant-config": "the assistant configuration (tighter than the default)",
  default: "the default",
} as const;

export function terminalEnvCommand(
  action: string | undefined,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  if (action && action !== "show") {
    process.stderr.write(`Unknown action "${action}". Use: show\n`);
    return 1;
  }
  // Only the user's own file here: this command has no assistant to read.
  resolveTerminalSettings(readUserTerminalSettings(), undefined);
  const status = getTerminalEnvironmentStatus(env);
  const { removed } = previewTerminalEnvironment(env, status.mode, status);
  out(`Mode: ${status.mode} (from ${SOURCES[status.source]})`);
  if (status.passEnv.length)
    out(`Passed through: ${status.passEnv.join(", ")}`);
  if (status.mode === "allowlist" && status.allow.length)
    out(`Also allowed: ${status.allow.join(", ")}`);
  out(
    removed.length
      ? `Removed from commands (${removed.length}): ${removed.join(", ")}`
      : "Nothing is removed from commands.",
  );
  return 0;
}
