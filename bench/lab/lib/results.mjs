// JSONL results: one record per completed case, appended as it finishes, so
// an interrupted run loses at most the case in flight and a rerun skips what
// is done.
import fs from "node:fs";
import path from "node:path";
import { appendLine, slug } from "./paths.mjs";

export const caseKey = (suite, model, caseId, pass) =>
  `${suite}|${model}|${caseId}|p${pass}`;

export const resultFile = (r, suite) =>
  path.join(r.results, `${slug(suite)}.jsonl`);

export function appendRecord(file, rec, r) {
  appendLine(file, JSON.stringify(rec), r);
}

/** Records in a file; a torn last line (an interrupted write) is ignored. */
export function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** Keys to skip on a rerun. Errors count as done unless retryErrors is set. */
export function doneKeys(records, { retryErrors = false } = {}) {
  const done = new Set();
  for (const rec of records) {
    if (retryErrors && rec.outcome === "error") continue;
    done.add(rec.key);
  }
  return done;
}

/** Every record of a directory of .jsonl files, or of the listed files. */
export function readAll(dirOrFiles) {
  const files = Array.isArray(dirOrFiles)
    ? dirOrFiles
    : fs.existsSync(dirOrFiles)
      ? fs
          .readdirSync(dirOrFiles)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(dirOrFiles, f))
      : [];
  return files.flatMap((f) => readRecords(f));
}
