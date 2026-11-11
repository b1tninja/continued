#!/usr/bin/env node
// Fixture provenance and licence check (docs/third-party-notices.md). Plain Node, no install.
//   hard failure, always: a corpus fixture with no provenance.source
//   advisory (failure with --strict): a Hugging Face sourced fixture with no provenance.license,
//   and a bench/research template excerpt longer than 1,200 characters
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MAX_EXCERPT_CHARS = 1200;
export const CORPUS = "core/llm/toolDialects/corpus/fixtures";
export const TEMPLATES = "bench/research/test/fixtures/templates";
export const DATASET = "bench/research/test/fixtures/dataset.json";
// Licence ids (as the Hugging Face card reports them) that restrict redistribution or use.
export const RESTRICTIVE = /^(llama|gemma|other)/i;

const HF_REPO = /huggingface\.co\/([^/\s,]+\/[^/\s,]+)/;

export function huggingFaceRepo(source) {
  return HF_REPO.exec(source ?? "")?.[1] ?? null;
}

export function inspect(root = process.cwd()) {
  const dsFile = join(root, DATASET);
  const licences = new Map();
  if (existsSync(dsFile))
    for (const [repo, rec] of Object.entries(
      JSON.parse(readFileSync(dsFile, "utf8")).repos ?? {},
    ))
      licences.set(repo.toLowerCase(), rec.license ?? null);

  const r = {
    total: 0,
    missingSource: [],
    hf: 0,
    missingLicence: [],
    knownLicence: 0,
    restrictive: new Map(),
    longExcerpts: [],
  };
  const dir = join(root, CORPUS);
  for (const f of existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .sort()
    : []) {
    r.total++;
    const prov =
      JSON.parse(readFileSync(join(dir, f), "utf8")).provenance ?? {};
    if (!prov.source) r.missingSource.push(f);
    const repo = huggingFaceRepo(prov.source);
    if (!repo) continue;
    r.hf++;
    const declared = prov.license ?? prov.licence;
    if (!declared) r.missingLicence.push(f);
    const lic = declared ?? licences.get(repo.toLowerCase());
    if (lic) r.knownLicence++;
    if (lic && RESTRICTIVE.test(lic)) r.restrictive.set(repo, lic);
  }
  const tdir = join(root, TEMPLATES);
  for (const f of existsSync(tdir) ? readdirSync(tdir).sort() : []) {
    const n = readFileSync(join(tdir, f), "utf8").length;
    if (n > MAX_EXCERPT_CHARS) r.longExcerpts.push(`${f} (${n} chars)`);
  }
  return r;
}

if (process.argv[1]?.endsWith("check-notice.mjs")) {
  const strict = process.argv.includes("--strict");
  const r = inspect();
  console.log(`corpus fixtures: ${r.total}; Hugging Face sourced: ${r.hf}`);
  console.log(`  missing provenance.source: ${r.missingSource.length}`);
  console.log(
    `  HF sourced without provenance.license: ${r.missingLicence.length} (licence known from dataset: ${r.knownLicence})`,
  );
  console.log(
    `  template excerpts over ${MAX_EXCERPT_CHARS} chars: ${r.longExcerpts.length}`,
  );
  for (const [repo, lic] of r.restrictive)
    console.log(`  restrictive licence: ${repo} (${lic})`);
  let fail = false;
  if (r.missingSource.length) {
    console.error(
      `missing provenance.source:\n  ${r.missingSource.join("\n  ")}`,
    );
    fail = true;
  }
  const advisories = [
    ...r.missingLicence.map((f) => `no provenance.license: ${f}`),
    ...r.longExcerpts.map((f) => `excerpt too long: ${f}`),
  ];
  if (advisories.length) {
    const out = strict ? console.error : console.log;
    out(
      `${strict ? "" : "advisory (--strict fails on these): "}${advisories.length} item(s)`,
    );
    if (strict) {
      for (const a of advisories) console.error(`  ${a}`);
      fail = true;
    }
  }
  process.exit(fail ? 1 : 0);
}
