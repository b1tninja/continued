/**
 * Scans files for secrets and exits 3 when it finds any. The same code as
 * `continuous secrets scan`, runnable from a checkout without building, so a
 * pre-commit hook in another repository can call it (docs: Secret scanning).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/secretScan.ts \
 *     [--profile at-rest|outbound] [--json] [--staged] [--salt s] [--allow fp]... \
 *     [--no-known] <path>...
 *
 * Prints rule id, file, line, column and fingerprint; never a value.
 */
import { runSecretsScan } from "core/util/secretScan/secretsCli.js";

function parse(argv: string[]) {
  const paths: string[] = [];
  const options: Parameters<typeof runSecretsScan>[1] = {};
  const allow: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") options.json = true;
    else if (a === "--staged") options.staged = true;
    else if (a === "--no-known") options.known = false;
    else if (a === "--profile") options.profile = argv[++i];
    else if (a === "--salt") options.salt = argv[++i];
    else if (a === "--allow") allow.push(argv[++i]);
    else paths.push(a);
  }
  options.allow = allow;
  return { paths, options };
}

const { paths, options } = parse(process.argv.slice(2));
process.exit(runSecretsScan(paths, options));
