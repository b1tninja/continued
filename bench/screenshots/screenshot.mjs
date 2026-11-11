#!/usr/bin/env node
// Pictures of the webview (gui/) in named states, light and dark, narrow and
// wide, with an optional comparison against an earlier run. Dev-only; see
// README.md in this folder.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, USAGE } from "./lib/args.mjs";
import { buildHarness, playwrightDir } from "./lib/build.mjs";
import { compareRuns, shoot } from "./lib/shoot.mjs";
import { VIEWS } from "./lib/views.mjs";

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.list) {
    for (const [name, v] of Object.entries(VIEWS)) {
      console.log(`${name.padEnd(16)} ${v.note}`);
    }
    return;
  }
  const out = path.resolve(opts.out);
  const pw = playwrightDir();
  const dist = opts.dist ? path.resolve(opts.dist) : buildHarness();

  let manifest;
  if (opts.sandbox) {
    const { shootInSandbox } = await import("./lib/sandbox.mjs");
    manifest = await shootInSandbox({
      dist,
      out,
      jobs: opts.jobs,
      playwrightDir: pw,
    });
  } else {
    manifest = await shoot({
      dist,
      out,
      jobs: opts.jobs,
      playwrightDir: pw,
      browser: opts.browser,
    });
  }
  const failed = manifest.entries.filter((e) => e.errors.length);
  console.error(
    `${manifest.entries.length} pictures in ${manifest.totalMs} ms with ${manifest.browser.kind} ${manifest.browser.version} -> ${out}`,
  );
  if (failed.length) {
    console.error(
      `${failed.length} pictures logged page errors (see manifest.json)`,
    );
  }
  if (!opts.dist) fs.rmSync(dist, { recursive: true, force: true });

  if (opts.diff) {
    const summary = await compareRuns({
      out,
      diff: path.resolve(opts.diff),
      playwrightDir: pw,
      browser: opts.browser === "edge" ? "edge" : opts.browser,
      threshold: opts.threshold,
      tolerance: opts.tolerance,
    });
    console.log(summary.lines.join("\n"));
    process.exitCode = summary.anyChanged ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
