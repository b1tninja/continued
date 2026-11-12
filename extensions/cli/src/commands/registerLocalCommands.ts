import type { Command } from "commander";

import { registerCleanCommand } from "./clean.js";
import { registerPlanCommand } from "./plan.js";
import { registerSecretsCommand } from "./secrets.js";

/**
 * Subcommands that work on local files and need no login: `secrets` (scan
 * files for secrets, exit 3 on a finding), `clean` (retention for the
 * product's own persisted files, dry run unless --yes) and `plan`
 * (`plan list` / `plan build`). Kept out of index.ts to hold its line limit.
 */
export function registerLocalCommands(program: Command): void {
  registerSecretsCommand(program);
  registerCleanCommand(program);
  registerPlanCommand(program);
}
