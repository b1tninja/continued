#!/usr/bin/env node
// Dev-only model research tool, slice 1. See README.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, exitCode, formatCheck } from "./lib/check.mjs";
import { buildDataset, fetchRepo } from "./lib/hf.mjs";
import {
  FetchError,
  USER_AGENT,
  createClient,
  defaultCacheDir,
} from "./lib/http.mjs";
import { report } from "./lib/report.mjs";
import { loadTable } from "./lib/table.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = resolve(HERE, "../../core/util/toolDialectPresetTable.ts");
const DATA = join(HERE, "data", "hf.json");

const HELP = `usage: node bench/research/mrt.mjs <command> [options]

  fetch   [--repo R ...] [--repos-file F] [--out FILE | --write] [--read-gated-config]
          [--budget N] [--offline] [--cache DIR]
          Read Hugging Face public metadata, classify each template, print the dataset
          JSON on stdout. --write saves it to bench/research/data/hf.json, --out elsewhere.
          Default repos: bench/research/repos.json
  check   [--data FILE] [--table FILE] [--strict]
          Compare the dataset with core/util/toolDialectPresetTable.ts.
          exit 0 clean, 1 disagreement (or undecided under --strict), 2 could not check
  report  [--data FILE] [--table FILE]    markdown tables on stdout

Never edits the table, never commits, never uses a credential, never calls a model.
User agent: ${USER_AGENT}`;

function parseArgs(argv) {
  const o = { _: [], repo: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) o._.push(a);
    else if (
      ["strict", "write", "offline", "read-gated-config", "help"].includes(
        a.slice(2),
      )
    ) {
      o[a.slice(2)] = true;
    } else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--repo") o.repo.push(v);
      else o[a.slice(2)] = v;
    }
  }
  return o;
}

async function cmdFetch(o) {
  let repos = o.repo;
  if (repos.length === 0) {
    const file = o["repos-file"] ?? join(HERE, "repos.json");
    repos = JSON.parse(readFileSync(file, "utf8")).map((x) => x.repo ?? x);
  }
  for (const v of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"]) {
    if (process.env[v]) {
      console.error(
        `note: ${v} is set and is ignored; this tool sends no credentials`,
      );
    }
  }
  const client = createClient({
    cacheDir: o.cache ?? defaultCacheDir(),
    budget: o.budget ? Number(o.budget) : 100,
    offline: !!o.offline,
    log: (m) => console.error(m),
  });
  const records = [];
  for (const repo of repos) {
    const rec = await fetchRepo(client, repo, {
      readGated: !!o["read-gated-config"],
    });
    console.error(
      `${rec.status.padEnd(11)} ${repo}  ${rec.template.dialect ?? `undecided: ${rec.template.reason ?? rec.detail}`}`,
    );
    records.push(rec);
  }
  console.error(`${client.used} request(s) sent`);
  const json = JSON.stringify(buildDataset(records), null, 2) + "\n";
  const out = o.write ? DATA : o.out;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    console.error(`wrote ${out}`);
  } else {
    process.stdout.write(json);
  }
}

function load(o) {
  const rows = loadTable(o.table ?? TABLE);
  const dataset = JSON.parse(readFileSync(o.data ?? DATA, "utf8"));
  return { result: compare(rows, dataset), dataset };
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const o = parseArgs(process.argv.slice(3));
  if (!cmd || cmd === "help" || cmd === "--help" || o.help) {
    console.log(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === "fetch") {
    await cmdFetch(o);
    return 0;
  }
  if (cmd === "check") {
    const { result } = load(o);
    console.log(formatCheck(result, { strict: !!o.strict }));
    return exitCode(result, { strict: !!o.strict });
  }
  if (cmd === "report") {
    const { result, dataset } = load(o);
    console.log(report(result, dataset));
    return 0;
  }
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // 2 = could not check; never the same exit as "checked and fine".
    console.error(
      `${e instanceof FetchError ? "fetch" : "error"}: ${e.message}`,
    );
    process.exit(2);
  },
);
