#!/usr/bin/env node
// The local lab CLI. Run `node bench/lab/lab.mjs help` for the commands.
// Read README.md first: this drives a real model on a real machine.
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadProduct } from "./adapter.mjs";
import { formatDiff } from "./lib/diff.mjs";
import { writeFixtures } from "./lib/fixtures.mjs";
import { Budget, machineFacts } from "./lib/guards.mjs";
import { formatInventory, inventory } from "./lib/inventory.mjs";
import { OllamaClient } from "./lib/ollama.mjs";
import { roots as makeRoots, writeText } from "./lib/paths.mjs";
import { buildReport } from "./lib/report.mjs";
import { readAll, readRecords, resultFile } from "./lib/results.mjs";
import { makePlan, runSuite, warmup } from "./lib/run.mjs";
import { agentTools, loadSuite, SUITE_NAMES } from "./lib/suites.mjs";
import { writeProfiles } from "./lib/suggest.mjs";

const HELP = `usage: node bench/lab/lab.mjs <command> [options]

commands
  inventory                 installed models, preset rows, machine facts, which are safe
  plan                      dry run: cases x models x passes and estimated time
  run --run                 run for real (without --run it only prints the plan)
  report                    markdown tables with Wilson 95% intervals
  diff <before> <after>     compare two result files
  suggest                   write profiles/<model>.json from the results
  fixtures --suite S        write observed corpus fixtures from raw replies
  snapshot-tools            write the real agent tool list (needs the product's install)

suites: ${SUITE_NAMES.join(", ")}  (or a path to a suite JSON file)

common options
  --suite S  --models a,b|smallest-safe|all-safe  --passes N  --limit N
  --base-url URL (loopback only unless --allow-remote)  --product DIR
  --max-vram GB (default 8)  --max-ram GB (default 16)
  --max-requests N (60)  --max-minutes N (30)  --model-minutes N (15)
  --request-timeout S (120)  --cooldown S (15)  --retry-errors  --ignore-loaded
  --styles auto|all|a,b  --modes native,text  --variants FILE  --deliveries native,text
  --dataset FILE  --tool-counts 2,14,60,agent  --temperatures 0,0.7  --streams false,true
  --num-ctx N (default 8192; the leaks suite uses 16384)  --full-grid  --warmup (plan: send one tiny request per model)  --out FILE  --file F (repeatable)
`;

const OPTIONS = {
  suite: { type: "string" },
  models: { type: "string" },
  passes: { type: "string", default: "1" },
  limit: { type: "string" },
  "base-url": { type: "string", default: "http://127.0.0.1:11434" },
  "allow-remote": { type: "boolean" },
  product: { type: "string" },
  run: { type: "boolean" },
  "max-vram": { type: "string", default: "8" },
  "max-ram": { type: "string", default: "16" },
  "max-requests": { type: "string", default: "60" },
  "max-minutes": { type: "string", default: "30" },
  "model-minutes": { type: "string", default: "15" },
  "request-timeout": { type: "string", default: "120" },
  cooldown: { type: "string", default: "15" },
  "retry-errors": { type: "boolean" },
  "ignore-loaded": { type: "boolean" },
  styles: { type: "string" },
  modes: { type: "string" },
  variants: { type: "string" },
  deliveries: { type: "string" },
  dataset: { type: "string" },
  "tool-counts": { type: "string" },
  temperatures: { type: "string" },
  streams: { type: "string" },
  "full-grid": { type: "boolean" },
  warmup: { type: "boolean" },
  out: { type: "string" },
  file: { type: "string", multiple: true },
  concurrency: { type: "string" },
  "num-ctx": { type: "string" },
  "min-n": { type: "string", default: "8" },
  "only-leaks": { type: "boolean" },
  "results-dir": { type: "string" },
  "profiles-dir": { type: "string" },
  help: { type: "boolean", short: "h" },
};

const die = (msg, code = 2) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};
const log = (s) => process.stderr.write(s + "\n");
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    die(`--${name} needs a non-negative number, got ${v}`);
  return n;
};

function suiteOptions(v) {
  return {
    styles: v.styles,
    modes: v.modes,
    variants: v.variants,
    deliveries: v.deliveries,
    dataset: v.dataset,
    toolCounts: v["tool-counts"],
    temperatures: v.temperatures,
    streams: v.streams,
    fullGrid: v["full-grid"],
    numCtx: v["num-ctx"] ? num(v["num-ctx"], "num-ctx") : undefined,
    limit: v.limit ? num(v.limit, "limit") : undefined,
    retryErrors: v["retry-errors"],
    ignoreLoaded: v["ignore-loaded"],
  };
}

async function pickModels(spec, inv) {
  if (!spec) die("--models is required (names, smallest-safe or all-safe)");
  const safe = inv.models.filter((m) => m.safe);
  if (spec === "smallest-safe") return safe.slice(0, 1);
  if (spec === "all-safe") return safe;
  return spec.split(",").map((n) => {
    const m = inv.models.find((x) => x.name === n.trim());
    if (!m)
      die(
        `model ${n} is not installed (see \`inventory\`); the lab never pulls models`,
      );
    return m;
  });
}

export async function main(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (e) {
    return die(`${e.message}\n\n${HELP}`);
  }
  const { values: v, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === "help" || v.help) return process.stdout.write(HELP);
  if (v.concurrency && v.concurrency !== "1")
    return die(
      "the lab runs one request at a time; --concurrency is fixed at 1",
    );
  const roots = makeRoots({
    results: v["results-dir"],
    profiles: v["profiles-dir"],
  });
  const limits = {
    maxVramGB: num(v["max-vram"], "max-vram"),
    maxRamGB: num(v["max-ram"], "max-ram"),
  };
  const ctl = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    log(
      "\ninterrupted: finishing this request, unloading the model, then exiting (Ctrl-C again to quit now)",
    );
    ctl.abort();
  });

  if (cmd === "report") {
    const recs = v.file?.length ? readAll(v.file) : readAll(roots.results);
    const recs2 = v.suite ? recs.filter((r) => r.suite === v.suite) : recs;
    const md = buildReport(recs2);
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }
  if (cmd === "diff") {
    if (rest.length !== 2)
      return die("diff needs two result files: diff <before> <after>");
    const md = formatDiff(readRecords(rest[0]), readRecords(rest[1]), [
      path.basename(rest[0]),
      path.basename(rest[1]),
    ]);
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }

  const product = await loadProduct(v.product);
  for (const m of product.missing)
    log(`note: product feature unavailable: ${m}`);

  if (cmd === "suggest") {
    const recs = v.file?.length ? readAll(v.file) : readAll(roots.results);
    const written = writeProfiles(recs, roots, {
      product,
      minN: num(v["min-n"], "min-n"),
    });
    for (const w of written)
      log(
        `profile ${w.model}: ${w.file}\n  best: ${w.profile.best ? `${w.profile.best.arm} ${w.profile.best.k}/${w.profile.best.n}` : "not enough evidence"}; ${w.profile.comparison}`,
      );
    return written.length || log("no results to learn from");
  }
  if (cmd === "snapshot-tools") {
    const tools = await product.agentTools();
    return log(
      "wrote " +
        writeText(
          v.out ?? path.join(roots.results, "agent-tools.snapshot.json"),
          JSON.stringify(tools, null, 2) + "\n",
          roots,
        ) +
        `  (${tools.length} tools; copy to bench/lab/fixtures/agent-tools.json to adopt)`,
    );
  }

  const client = new OllamaClient({
    baseUrl: v["base-url"],
    allowRemote: v["allow-remote"],
    requestTimeoutMs: num(v["request-timeout"], "request-timeout") * 1000,
    signal: ctl.signal,
  });
  const facts = machineFacts({ env });
  const inv = await inventory({ client, product, limits, facts });
  if (cmd === "inventory")
    return process.stdout.write(formatInventory(inv, limits));

  if (cmd === "fixtures") {
    const suite = loadSuite(v.suite ?? die("--suite is required"));
    const files = writeFixtures({
      product,
      suite,
      records: readRecords(resultFile(roots, suite.suite)),
      roots,
      opts: { ...suiteOptions(v), onlyLeaks: v["only-leaks"] },
      agentTools: agentTools(),
    });
    return log(
      `wrote ${files.length} fixture(s) under ${path.join(roots.results, "fixtures")}`,
    );
  }

  if (cmd !== "plan" && cmd !== "run")
    return die(`unknown command ${cmd}\n\n${HELP}`);
  const suite = loadSuite(v.suite ?? die("--suite is required"));
  const models = await pickModels(v.models, inv);
  const opts = suiteOptions(v);
  const passes = num(v.passes, "passes") || 1;
  const budget = new Budget({
    maxRequests: num(v["max-requests"], "max-requests"),
    maxMs: num(v["max-minutes"], "max-minutes") * 60_000,
  });
  const history = readRecords(resultFile(roots, suite.suite));
  const warm = {};
  if (cmd === "plan" && v.warmup) {
    for (const m of models) {
      const g = inv.models.find((x) => x.name === m.name);
      if (!g?.safe) {
        log(`warmup skipped for ${m.name}: not safe under the limits`);
        continue;
      }
      log(`warmup ${m.name} (1 request)`);
      try {
        budget.spend(1);
        warm[m.name] = await warmup(client, m.name);
      } catch (e) {
        log(`warmup failed: ${e.message}`);
      }
      await client.unload(m.name);
    }
  }
  const plan = makePlan({
    suite,
    models,
    passes,
    opts,
    product,
    history,
    warm,
    agentTools: agentTools(),
  });
  log(
    `${cmd === "run" && v.run ? "RUN" : "DRY RUN"}: suite ${suite.suite}, results ${resultFile(roots, suite.suite)}`,
  );
  let total = 0;
  for (const p of plan) {
    const g = inv.models.find((x) => x.name === p.model);
    total += p.estSeconds;
    log(
      `  ${p.model}: ${p.cases} cases x ${p.passes} = ${p.total}, ${p.remaining} to run, ~${(p.estSeconds / 60).toFixed(1)} min at ${p.tps ? p.tps.toFixed(1) : "20 (assumed)"} tok/s (${p.tpsSource}); ${g?.safe ? "safe" : "REFUSED: " + (g?.guard.reasons.join("; ") ?? "?")}`,
    );
  }
  log(
    `  total ~${(total / 60).toFixed(1)} min, ${plan.reduce((s, p) => s + p.remaining, 0)} requests; budget ${budget.maxRequests} requests, ${(budget.maxMs / 60000).toFixed(0)} min`,
  );
  if (cmd === "plan") return;
  if (!v.run) return log("dry: nothing was sent. Add --run to run for real.");
  const summary = await runSuite({
    client,
    product,
    suite,
    models,
    passes,
    opts,
    roots,
    budget,
    signal: ctl.signal,
    log,
    facts,
    limits,
    cooldownMs: num(v.cooldown, "cooldown") * 1000,
    modelMaxMs: num(v["model-minutes"], "model-minutes") * 60_000,
    agentTools: agentTools(),
  });
  log(
    `done: ${summary.ran} ran, ${summary.skipped} already done, ${summary.errors} errors, ${summary.refused.length} model(s) refused${summary.stopped ? `; stopped: ${summary.stopped}` : ""}`,
  );
  if (summary.stopped === "interrupted") process.exitCode = 130;
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  });
}
