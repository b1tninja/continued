/**
 * The file scanner behind `continuous secrets scan` (ROADMAP X7) and the
 * standalone script. Node only. Reports a rule id, a file, a line and column
 * and a fingerprint for each finding; never the value, and never the line it
 * is on.
 */
import fs from "node:fs";
import path from "node:path";

import { scanText } from "./scan";
import type {
  KnownValueMatcher,
  SecretConfidence,
  SecretProfile,
} from "./types";

export const EXIT_CLEAN = 0;
export const EXIT_USAGE = 2;
export const EXIT_FINDINGS = 3;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "coverage",
]);

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface FileFinding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  kind: string;
  confidence: SecretConfidence;
  fingerprint: string;
}

export interface SkippedFile {
  file: string;
  reason: "binary" | "too-large" | "unreadable";
}

export interface ScanReport {
  profile: SecretProfile;
  filesScanned: number;
  skipped: SkippedFile[];
  findings: FileFinding[];
}

export interface ScanPathsOptions {
  profile: SecretProfile;
  salt?: string;
  known?: KnownValueMatcher;
  allowFingerprints?: ReadonlySet<string>;
  maxBytes?: number;
}

/** Files under `inputs`: a file is itself, a directory is walked. */
export function expandPaths(inputs: readonly string[]): {
  files: string[];
  missing: string[];
} {
  const files: string[] = [];
  const missing: string[] = [];
  const walk = (p: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      missing.push(p);
      return;
    }
    if (stat.isFile()) {
      files.push(p);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(p).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path.join(p, name));
    }
  };
  for (const input of inputs) walk(input);
  return { files, missing };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

function positionOf(starts: number[], offset: number) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

/** Read a file as text, or say why not. */
function readText(
  file: string,
  maxBytes: number,
): { text: string } | { skip: SkippedFile["reason"] } {
  try {
    if (fs.statSync(file).size > maxBytes) return { skip: "too-large" };
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return { skip: "binary" };
    return { text: buf.toString("utf8") };
  } catch {
    return { skip: "unreadable" };
  }
}

/** Scan `files` (already expanded) and collect findings. */
export function scanFileList(
  files: readonly string[],
  options: ScanPathsOptions,
): ScanReport {
  const report: ScanReport = {
    profile: options.profile,
    filesScanned: 0,
    skipped: [],
    findings: [],
  };
  const salt = options.salt;
  for (const file of files) {
    const read = readText(file, options.maxBytes ?? DEFAULT_MAX_BYTES);
    if ("skip" in read) {
      report.skipped.push({ file, reason: read.skip });
      continue;
    }
    report.filesScanned++;
    const found = scanText(read.text, options.profile, {
      salt,
      path: file,
      known: options.known,
      allowFingerprints: options.allowFingerprints,
    });
    if (!found.length) continue;
    const starts = lineStarts(read.text);
    for (const f of found) {
      report.findings.push({
        file,
        ...positionOf(starts, f.start),
        ruleId: f.ruleId,
        kind: f.kind,
        confidence: f.confidence,
        fingerprint: f.fingerprint,
      });
    }
  }
  return report;
}

/** One line per finding: `file:line:col  rule  confidence  fingerprint`. */
export function formatReport(report: ScanReport): string {
  const lines = report.findings.map(
    (f) =>
      `${f.file}:${f.line}:${f.column}  ${f.ruleId}  ${f.confidence}  ${f.fingerprint}`,
  );
  for (const s of report.skipped)
    lines.push(`${s.file}  skipped (${s.reason})`);
  lines.push(
    report.findings.length
      ? `${report.findings.length} finding(s) in ${new Set(report.findings.map((f) => f.file)).size} file(s), ${report.filesScanned} scanned, profile ${report.profile}. Values are not printed.`
      : `No findings in ${report.filesScanned} file(s), profile ${report.profile}.`,
  );
  return lines.join("\n");
}
