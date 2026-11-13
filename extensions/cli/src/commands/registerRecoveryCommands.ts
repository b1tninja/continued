import type { Command } from "commander";

import { gracefulExit } from "../util/exit.js";

import { doctorConfigCommand } from "./doctorConfig.js";

/**
 * Subcommands for getting out of a broken state. Kept out of index.ts to hold
 * its line limit.
 *
 * `config check [file]` is `doctor config` under the name people look for
 * when a config file does not load.
 */
export function registerRecoveryCommands(program: Command): void {
  program
    .command("config [action] [file]")
    .description(
      "config check [file]: do config.yaml, permissions.yaml, the hook settings and the MCP server entries parse, and what is each control's value and source (same as doctor config)",
    )
    .option("--json", "Machine-readable output")
    .action(
      async (
        action: string | undefined,
        file: string | undefined,
        options: { json?: boolean },
      ) => {
        if (action !== "check") {
          process.stderr.write("Usage: continuous config check [file]\n");
          await gracefulExit(1);
          return;
        }
        const code = doctorConfigCommand({
          json: options.json,
          configFile: file,
          flags: program.opts(),
        });
        await gracefulExit(code);
      },
    );
}
