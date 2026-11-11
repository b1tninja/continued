/**
 * `continuous secrets scan <paths...> [--profile at-rest|outbound] [--json]`
 * (ROADMAP X7): scan files for secrets before they leave the temp directory
 * or are committed. The scanner is `core/util/secretScan`; this file only
 * adapts the arguments. Exit 0 clean, 3 findings, 2 usage. Values are never
 * printed.
 */
import { Option, type Command } from "commander";
import { getGlobalDirPath } from "core/util/paths.js";
import { EXIT_USAGE } from "core/util/secretScan/scanFiles.js";
import {
  runSecretsScan,
  type Io,
  type SecretsScanOptions,
} from "core/util/secretScan/secretsCli.js";

import { gracefulExit } from "../util/exit.js";

export const historyOption = new Option(
  "--history",
  "Scan this product's own stores (sessions, dev_data, logs) for secrets already on disk",
);
export const includeClaudeCodeOption = new Option(
  "--include-claude-code",
  "With --history: also read ~/.claude/projects transcripts, read-only",
);

export function secretsCommand(
  action: string | undefined,
  paths: string[],
  options: SecretsScanOptions,
  io?: Io,
): number {
  if (action !== "scan") {
    const message = `Usage: continuous secrets scan <paths...> [--profile at-rest|outbound] [--json] [--staged] [--history [--include-claude-code]]`;
    (io?.err ?? console.error)(message);
    return EXIT_USAGE;
  }
  return runSecretsScan(
    paths,
    options.history
      ? { ...options, globalDir: options.globalDir ?? getGlobalDirPath() }
      : options,
    io,
  );
}

/** Adds `continuous secrets` to the program. */
export function registerSecretsCommand(program: Command): void {
  program
    .command("secrets [action] [paths...]")
    .description(
      "Scan files for secrets before they are committed or leave the machine; values are never printed (scan)",
    )
    .option("--profile <p>", "at-rest (default, recall first) or outbound")
    .option("--json", "Machine-readable output")
    .option("--staged", "Also scan the files staged in git")
    .option("--salt <s>", "Fingerprint salt, to keep fingerprints comparable")
    .option(
      "--allow <fp>",
      "A fingerprint to treat as not a secret (repeatable)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--no-known", "Do not match this machine's own secret values")
    .addOption(historyOption)
    .addOption(includeClaudeCodeOption)
    .action(
      async (
        action: string | undefined,
        paths: string[] | undefined,
        options,
      ) => {
        await gracefulExit(secretsCommand(action, paths ?? [], options));
      },
    );
}
