/**
 * Runs the stuck signals over recorded histories and prints the fire rate of
 * each signal (plans/stuck-detection.md, S1). Changes nothing.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/measureStuck.ts [--labels labels.json] [--json] [--segment-by-user] <file|dir>...
 *
 * Each file is a saved session (`~/.continue/sessions/*.json`, CLI or IDE), a
 * bare history array, or a bench result with `state.history`; a directory is
 * searched for `.json` files. `labels.json` maps a file's base name (no
 * extension) to "healthy" or "stuck"; unlabelled runs count in the overall
 * rates but not in the healthy or stuck columns, so a table without labels
 * cannot answer the 5% question. `--segment-by-user` measures each stretch after a
 * user message as its own run (the scope OpenHands gives its detector, and the
 * right one for a loop session that receives a message per item); a segment's
 * id is the file's plus `#n`, and a label applies to every segment of the file.
 */
import fs from "node:fs";
import path from "node:path";

import {
  detectHost,
  historyOfSessionJson,
  segmentAtUserMessages,
  stepsFromHistory,
} from "core/util/stuckHistory.js";
import {
  formatMeasurement,
  measureRuns,
  type MeasuredRun,
  type RunLabel,
} from "core/util/stuckMeasure.js";

function collect(target: string, out: string[]): void {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const e of fs.readdirSync(target)) collect(path.join(target, e), out);
  } else if (target.endsWith(".json")) {
    out.push(target);
  }
}

function main(argv: string[]): void {
  const targets: string[] = [];
  let labels: Record<string, RunLabel> = {};
  let asJson = false;
  let segment = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--labels") {
      labels = JSON.parse(fs.readFileSync(argv[++i], "utf8"));
    } else if (argv[i] === "--segment-by-user") {
      segment = true;
    } else if (argv[i] === "--json") {
      asJson = true;
    } else {
      targets.push(argv[i]);
    }
  }
  if (targets.length === 0) {
    console.error(
      "usage: measureStuck.ts [--labels f.json] [--json] [--segment-by-user] <file|dir>...",
    );
    process.exit(2);
  }
  const files: string[] = [];
  for (const t of targets) collect(t, files);

  const runs: MeasuredRun[] = [];
  let skipped = 0;
  const hosts = { cli: 0, gui: 0 };
  for (const file of files) {
    let history;
    try {
      history = historyOfSessionJson(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      history = undefined;
    }
    if (!history) {
      skipped++;
      continue;
    }
    const id = path.basename(file, ".json");
    hosts[detectHost(history)]++;
    const parts = segment ? segmentAtUserMessages(history) : [history];
    parts.forEach((part, n) => {
      runs.push({
        id: segment ? `${id}#${n}` : id,
        label: labels[id] ?? "unlabeled",
        steps: stepsFromHistory(part),
      });
    });
  }
  const m = measureRuns(runs.filter((r) => r.steps.length > 0));
  if (asJson) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(formatMeasurement(m));
    console.log(
      `\nHosts: cli ${hosts.cli}, gui ${hosts.gui}; skipped ${skipped} file(s) that held no history`,
    );
  }
}

main(process.argv.slice(2));
