#!/usr/bin/env node
// Adds provenance.license to the Hugging Face sourced corpus fixtures (docs/third-party-notices.md).
// Plain Node. The licence id per repository comes from bench/research/test/fixtures/dataset.json, and for a
// repository it does not cover from the public Hub API (GET /api/models/<repo>, no credentials, one request per
// second). The field is inserted as one line after `"source"`; nothing else in the file is touched, so run
// prettier afterwards. A fixture that already has the field is left alone.
//   node scripts/ci/backfill-fixture-licence.mjs [--dry-run]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS = "core/llm/toolDialects/corpus/fixtures";
const DATASET = "bench/research/test/fixtures/dataset.json";
const HF_REPO = /huggingface\.co\/([^/\s,]+\/[^/\s,]+)/;
const huggingFaceRepo = (source) => HF_REPO.exec(source ?? "")?.[1] ?? null;

const DELAY_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function licenceOf(model) {
  const card = model?.cardData?.license ?? model?.license;
  if (card) return String(card);
  const tag = (model?.tags ?? []).find((t) => t.startsWith("license:"));
  return tag ? tag.slice("license:".length) : null;
}

export async function fetchLicence(repo, fetchFn = fetch) {
  const res = await fetchFn(`https://huggingface.co/api/models/${repo}`, {
    headers: { "User-Agent": "fixture-licence-backfill" },
  });
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  return licenceOf(await res.json());
}

/** Insert `"license"` after the `"source"` line of `provenance`; undefined when it is already there or no anchor. */
export function insertLicence(text, licence) {
  if (/^\s*"license":/m.test(text)) return undefined;
  const re = /^(\s*)"source": .*,\r?$/m;
  const m = re.exec(text);
  if (!m) return undefined;
  const eol = m[0].endsWith("\r") ? "\r" : "";
  const line = `${m[1]}"license": ${JSON.stringify(licence)},${eol}`;
  return text.replace(re, (all) => `${all}\n${line}`);
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const known = new Map();
  for (const [repo, rec] of Object.entries(
    JSON.parse(readFileSync(DATASET, "utf8")).repos ?? {},
  ))
    if (rec.license) known.set(repo.toLowerCase(), rec.license);

  const files = readdirSync(CORPUS)
    .filter((n) => n.endsWith(".json"))
    .sort();
  const byLicence = new Map();
  let changed = 0;
  let fetched = 0;
  for (const f of files) {
    const path = join(CORPUS, f);
    const text = readFileSync(path, "utf8");
    const repo = huggingFaceRepo(JSON.parse(text).provenance?.source);
    if (!repo) continue;
    const key = repo.toLowerCase();
    if (!known.has(key)) {
      if (fetched++) await sleep(DELAY_MS);
      const lic = await fetchLicence(repo);
      if (!lic) throw new Error(`${repo}: the Hub reports no licence`);
      known.set(key, lic);
    }
    const lic = known.get(key);
    const next = insertLicence(text, lic);
    if (next === undefined) continue;
    byLicence.set(lic, (byLicence.get(lic) ?? 0) + 1);
    changed++;
    if (!dry) writeFileSync(path, next);
  }
  console.log(
    `${dry ? "would add" : "added"} provenance.license to ${changed} fixtures`,
  );
  for (const [lic, n] of [...byLicence].sort()) console.log(`  ${lic}: ${n}`);
}

if (process.argv[1]?.endsWith("backfill-fixture-licence.mjs")) await main();
