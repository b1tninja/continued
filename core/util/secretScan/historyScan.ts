/**
 * `continuous secrets scan --history` (ROADMAP X15): which stores to scan and
 * what to tell the person afterwards. Node only. Everything is READ-ONLY: a
 * file under `~/.claude/projects` is opened for reading and never written.
 * Output carries counts, rule ids, paths and fingerprints, never a value.
 */
import fs from "node:fs";
import path from "node:path";

import { isLooselyShared } from "../privateFiles";

import { countByRule } from "./scan";
import type { ScanReport } from "./scanFiles";

export const HISTORY_MAX_BYTES = 64 * 1024 * 1024;

/** Our own stores under the global folder, and (opt in) Claude Code transcripts. */
export function historyRoots(opts: {
  globalDir: string;
  includeClaudeCode?: boolean;
  home?: string;
}): string[] {
  const roots = ["sessions", "dev_data", "logs"].map((d) =>
    path.join(opts.globalDir, d),
  );
  if (opts.includeClaudeCode && opts.home) {
    roots.push(path.join(opts.home, ".claude", "projects"));
  }
  return roots;
}

/** Files group- or world-accessible (POSIX); a Windows run reports none. */
export function looseFiles(files: readonly string[]): string[] {
  return files.filter((f) => {
    try {
      return isLooselyShared(fs.statSync(f).mode);
    } catch {
      return false;
    }
  });
}

export const ROTATION_GUIDANCE = [
  "A finding means a credential was written to a file on this disk. Treat it as exposed to anything that can read that file (other local users, backups, sync clients, a support bundle).",
  "Rotate it at the issuer, then delete or clean the file: `continuous clean --older-than 0.001d --yes` removes our own stores; a Claude Code transcript is Claude Code's file, so delete it with that tool's own cleanup (`cleanupPeriodDays`) or by hand.",
  "Fingerprints are salted per run unless you pass --salt: use the same --salt to compare two runs. Rule ids name the kind of credential; no value is printed anywhere.",
];

export function formatHistorySummary(
  report: ScanReport,
  loose: readonly string[],
): string[] {
  const out: string[] = [];
  const counts = countByRule(report.findings as never);
  const rules = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id}=${n}`);
  out.push(
    `History: ${report.findings.length} finding(s) in ${report.filesScanned} file(s)${rules.length ? ` (${rules.join(", ")})` : ""}.`,
  );
  if (loose.length) {
    out.push(
      `${loose.length} file(s) readable by group or others (chmod 600 them): ${loose.slice(0, 5).join(", ")}${loose.length > 5 ? ", ..." : ""}`,
    );
  }
  if (report.findings.length) out.push(...ROTATION_GUIDANCE);
  return out;
}
