/**
 * `continuous secrets scan <paths...> [--profile at-rest|outbound] [--json]`
 * (ROADMAP X7): scan files for secrets before they leave the temp directory
 * or are committed. The scanner is `core/util/secretScan`; this file only
 * adapts the arguments. Exit 0 clean, 3 findings, 2 usage. Values are never
 * printed.
 */
import {
  runSecretsScan,
  type Io,
  type SecretsScanOptions,
} from "core/util/secretScan/secretsCli.js";
import { EXIT_USAGE } from "core/util/secretScan/scanFiles.js";

export function secretsCommand(
  action: string | undefined,
  paths: string[],
  options: SecretsScanOptions,
  io?: Io,
): number {
  if (action !== "scan") {
    const message = `Usage: continuous secrets scan <paths...> [--profile at-rest|outbound] [--json] [--staged]`;
    (io?.err ?? console.error)(message);
    return EXIT_USAGE;
  }
  return runSecretsScan(paths, options, io);
}
