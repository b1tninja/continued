#!/usr/bin/env node
// Tier 1 shape probes (plans/model-benchmark.md section 4.5): turns the
// declarative definitions in bench/probes/families.yaml into request files and
// a run.sh of `aws bedrock-runtime` and `curl` commands. This program never
// sends a request; running run.sh is what costs money, and the owner decides
// that. Output goes where --emit says, outside the repository.
//
//   node bench/probe.mjs --list
//   node bench/probe.mjs --family kimi-k3 --emit /tmp/bench/probes
//   node bench/probe.mjs --family all --emit /tmp/bench/probes --region us-east-1 --profile torgate
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

import { findModelRow, loadMatrix, BENCH_ROOT } from "./src/common.mjs";

export const PROBES_FILE = path.join(BENCH_ROOT, "probes", "families.yaml");

export function loadProbes(file = PROBES_FILE) {
  const doc = YAML.parse(fs.readFileSync(file, "utf-8"));
  if (!Array.isArray(doc.probes) || typeof doc.families !== "object")
    throw new Error(`${file}: need probes (a list) and families (a map)`);
  return doc;
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

// Keys whose value is one choice among several, so a probe that overrides it
// replaces it rather than adding a second choice beside the first.
const REPLACED = new Set(["toolChoice", "tool_choice"]);

/** Deep merge: objects merge key by key, anything else is replaced. */
export function merge(base, over) {
  if (!isObject(base) || !isObject(over))
    return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over))
    out[k] = REPLACED.has(k) ? v : merge(base[k], v);
  return out;
}

/** The probe with its `base` resolved and its own fields laid over it. */
export function resolveProbe(doc, id) {
  const probe = doc.probes.find((p) => p.id === id);
  if (!probe) throw new Error(`No probe ${id}`);
  if (!probe.base) return probe;
  const base = resolveProbe(doc, probe.base);
  const { base: _b, ...own } = probe;
  return { ...merge(base, own), id: probe.id };
}

/** Where the Mantle endpoint lives for a row (Grok uses /openai/v1). */
export function mantleBase(region, model) {
  const prefix = /(^|\.)xai\./i.test(model) ? "/openai/v1" : "/v1";
  return `https://bedrock-mantle.${region}.api.aws${prefix}`;
}

/**
 * The requests for one family: [{ file, probe, variant, stream, route, body }].
 * `body` is the JSON the aws CLI (converse) or curl (chat) sends.
 */
export function requestsFor(doc, familyId, matrix) {
  const fam = doc.families[familyId];
  if (!fam) throw new Error(`No family ${familyId}`);
  const row = findModelRow(matrix, fam.row);
  const out = [];
  for (const probeId of fam.probes) {
    const probe = resolveProbe(doc, probeId);
    const shape = probe[fam.route];
    if (!shape) continue; // a converse-only probe on a chat family
    const variants = probe.expandVariants
      ? (fam.variants ?? []).filter((v) => v[fam.route])
      : [null];
    for (const variant of variants) {
      let body = merge({}, shape);
      if (variant) body = merge(body, variant[fam.route]);
      if (fam.route === "converse") body = { modelId: row.model, ...body };
      else body = { model: row.model, ...body };
      const name = variant ? `${probeId}.${variant.id}` : probeId;
      out.push({
        file: `${familyId}/${name}.json`,
        name,
        probe: probeId,
        variant: variant?.id ?? null,
        note: variant?.note ?? null,
        stream: !!probe.stream,
        route: fam.route,
        body,
      });
    }
  }
  return { family: fam, row, requests: out };
}

/** The shell lines that send one request and keep the answer. */
export function commandFor(req, opts) {
  const f = `"$OUT/${req.file.replace(/\.json$/, "")}`;
  if (req.route === "converse") {
    const verb = req.stream ? "converse-stream" : "converse";
    return (
      `aws bedrock-runtime ${verb} --region ${opts.region} --profile ${opts.profile} ` +
      `--cli-input-json file://"$OUT/${req.file}" > ${f}.out.json" 2> ${f}.err.txt" || true`
    );
  }
  return (
    `curl -sS -X POST "${opts.base}/chat/completions" ` +
    `-H "Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK" -H "Content-Type: application/json" ` +
    `-d @"$OUT/${req.file}" -o ${f}.out.json" -w "%{http_code}\\n" > ${f}.status.txt" || true`
  );
}

function parseArgs(argv) {
  const o = { region: "us-east-1", profile: "torgate" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--family") o.family = next();
    else if (a === "--emit") o.emit = next();
    else if (a === "--region") o.region = next();
    else if (a === "--profile") o.profile = next();
    else if (a === "--list") o.list = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const doc = loadProbes();
  const matrix = loadMatrix();
  if (o.help || (!o.list && !o.family)) {
    console.log(
      "usage: node bench/probe.mjs --list | --family <id|all> --emit <dir> [--region r] [--profile p]\n" +
        "Writes request files and run.sh; sends nothing.",
    );
    return;
  }
  if (o.list) {
    for (const [id, f] of Object.entries(doc.families)) {
      const { requests } = requestsFor(doc, id, matrix);
      console.log(
        `${id.padEnd(20)} ${f.route.padEnd(9)} ${String(requests.length).padStart(2)} requests  ${f.status}  row ${f.row}`,
      );
    }
    return;
  }
  if (!o.emit) throw new Error("--emit <dir> is required with --family");
  const ids = o.family === "all" ? Object.keys(doc.families) : [o.family];
  const lines = [
    "#!/usr/bin/env bash",
    "# Tier 1 shape probes. Running this sends real requests and costs money:",
    "# 4 to 15 small requests per family. Read the requests under $OUT first.",
    `# Bedrock credentials: aws profile ${o.profile}; chat routes read AWS_BEARER_TOKEN_BEDROCK.`,
    'OUT="$(cd "$(dirname "$0")" && pwd)"',
    "",
  ];
  let total = 0;
  for (const id of ids) {
    const { family, row, requests } = requestsFor(doc, id, matrix);
    const base =
      family.route === "chat"
        ? mantleBase(row.providerDefaults?.region ?? o.region, row.model)
        : null;
    lines.push(`# ${id} (${row.model}, ${family.route}, ${family.status})`);
    for (const req of requests) {
      const file = path.join(o.emit, req.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(req.body, null, 2) + "\n");
      lines.push(
        commandFor(req, { region: o.region, profile: o.profile, base }),
      );
      total++;
    }
    lines.push("");
  }
  const sh = path.join(o.emit, "run.sh");
  fs.writeFileSync(sh, lines.join("\n"));
  console.log(`wrote ${total} requests and ${sh}; nothing was sent`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
