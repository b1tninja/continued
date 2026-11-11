#!/usr/bin/env node
/**
 * Live tool-call capture (plans/live-capture.md). Bundles
 * llm/toolDialects/capture/cli.ts with esbuild into node_modules/.cache (so
 * package imports resolve) and runs it. Plans only unless --run is given.
 *
 *   node scripts/capture-live.mjs --model bedrock:us.meta.llama3-3-70b-instruct-v1:0 --profile torgate
 *   node scripts/capture-live.mjs --model openai:qwen3-coder:30b --run
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "node_modules", ".cache", "capture-live", "cli.mjs");
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(root, "llm", "toolDialects", "capture", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "error",
});
const { main } = await import(pathToFileURL(outfile).href);
process.exit(await main(process.argv.slice(2)));
