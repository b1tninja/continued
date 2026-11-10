#!/usr/bin/env node
/**
 * Replay a recorded session against a simulated prompt cache under several
 * ageing policies and print the table (tokens, cache reads and writes,
 * rebuilds, simulated cost). Offline: no model is called.
 *
 *   npm run replay:ageing -- --input <session.json>
 *   npm run replay:ageing -- --synthetic 80
 *
 * A thin wrapper around util/cacheReplay.report.vitest.ts, which reads the
 * REPLAY_* environment variables. Same shape as scripts/turns-eval.mjs.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: npm run replay:ageing -- (--input <file> | --synthetic <turns>) [options]

  --input <file>        session JSON, an array of messages, or an array of history items
  --synthetic <turns>   a generated session instead of a file
  --gap <seconds>       seconds between requests (default 30)
  --ttl <seconds>       cache lifetime (default 300; above 300 prices writes at 2x)
  --triggers <a,b,c>    batch triggers in tokens (default 20000,40000,80000)
  --keep <a,b,c>        newest tool results kept whole (default 3,5,10)
  --out <file>          also write the markdown table to a file
`;

const flags = {
  "--input": "REPLAY_INPUT",
  "--synthetic": "REPLAY_SYNTHETIC",
  "--gap": "REPLAY_GAP",
  "--ttl": "REPLAY_TTL",
  "--triggers": "REPLAY_TRIGGERS",
  "--keep": "REPLAY_KEEP",
  "--out": "REPLAY_OUT",
};

const env = { ...process.env };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  const name = flags[a];
  if (!name || i + 1 >= args.length) {
    console.error(`Unknown or incomplete option: ${a}\n\n${HELP}`);
    process.exit(2);
  }
  env[name] = ["--input", "--out"].includes(a) ? resolve(args[++i]) : args[++i];
}
if (!env.REPLAY_INPUT && !env.REPLAY_SYNTHETIC) {
  console.error(HELP);
  process.exit(2);
}

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(
  "npx",
  ["vitest", "run", "util/cacheReplay.report.vitest.ts", "--reporter=basic"],
  {
    cwd: coreDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
process.exit(run.status ?? 1);
