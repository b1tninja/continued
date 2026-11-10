#!/usr/bin/env node
/**
 * Lists tool-dialect preset rows whose `readOn` date is older than N days and
 * prints the source URLs to re-read. Exits 1 when more than `--max-stale`
 * rows are stale. Manual tool: it is NOT wired into CI and fetches nothing.
 *
 *   node core/scripts/preset-drift.mjs [--days 90] [--max-stale 0]
 *                                      [--today YYYY-MM-DD] [--table <path>]
 *
 * It reads core/util/toolDialectPresetTable.ts as text (the table is data
 * only), resolving the `READ` constant, so it needs no TypeScript build.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Rows as {id, readOn, sources} from the table's source text. */
export function parseRows(text) {
  text = text.replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));
  const read = /const READ = "(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
  const vllm = /const VLLM_DOCS =\s*"([^"]+)"/.exec(text)?.[1];
  const parts = text.split(/\n {2}\{\n {4}id: /).slice(1);
  return parts.map((part) => {
    const id = /^"([^"]+)"/.exec(part)?.[1] ?? "?";
    const readRaw = /\n {4}readOn: (READ|"[^"]+"),/.exec(part)?.[1];
    const readOn = readRaw === "READ" ? read : readRaw?.slice(1, -1);
    const block =
      /\n {4}source: \[([\s\S]*?)\],\n {4}readOn/.exec(part)?.[1] ?? "";
    const sources = [];
    for (const m of block.matchAll(/"(https?:\/\/[^"]+)"|\b(VLLM_DOCS)\b/g)) {
      sources.push(m[1] ?? vllm);
    }
    return { id, readOn, sources };
  });
}

/** Whole days from `readOn` to `today` (both YYYY-MM-DD). */
export function ageDays(readOn, today) {
  return Math.floor((Date.parse(today) - Date.parse(readOn)) / 86400000);
}

export function staleRows(rows, days, today) {
  return rows
    .map((r) => ({ ...r, age: r.readOn ? ageDays(r.readOn, today) : Infinity }))
    .filter((r) => r.age > days)
    .sort((a, b) => b.age - a.age);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const days = Number(arg("days", "90"));
  const maxStale = Number(arg("max-stale", "0"));
  const today = arg("today", new Date().toISOString().slice(0, 10));
  const table = arg(
    "table",
    resolve(here, "../util/toolDialectPresetTable.ts"),
  );
  const rows = parseRows(readFileSync(table, "utf8"));
  const stale = staleRows(rows, days, today);
  console.log(
    `${rows.length} rows, ${stale.length} read more than ${days} days before ${today}`,
  );
  for (const r of stale) {
    console.log(`\n${r.id}  readOn ${r.readOn ?? "missing"}  (${r.age} days)`);
    for (const u of r.sources) console.log(`  recheck ${u}`);
  }
  if (stale.length > maxStale) {
    console.error(
      `\n${stale.length} stale rows exceed --max-stale ${maxStale}`,
    );
    process.exit(1);
  }
}
