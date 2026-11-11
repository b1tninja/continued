/**
 * `continuous audit shadow`: what the reviewer would have decided, against what
 * was decided (ROADMAP B16). Read-only. Everything printed comes from audit
 * records, which hold masked arguments only; the text is masked once more on
 * the way out.
 */

import { maskText } from "core/tools/permissions/audit/mask.js";
import {
  POLICIES,
  readShadowRecords,
  shadowReport,
  type ShadowReport,
} from "core/tools/permissions/audit/shadowReport.js";

export interface AuditShadowOptions {
  json?: boolean;
  session?: string;
  since?: string;
  until?: string;
  model?: string;
  limit?: string | number;
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

function pct(part: number, whole: number): string {
  return whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;
}

/** The report as lines of text. */
export function formatShadowReport(r: ShadowReport, limit = 20): string[] {
  if (r.reviews === 0) {
    return [
      "No shadow reviews recorded. Turn them on in your own config.yaml (audit.shadowReviewer with enabled: true and budgetUsd).",
    ];
  }
  const lines = [
    `Shadow reviews: ${r.reviews}. Agreed: ${r.agreed} (${pct(r.agreed, r.reviews)}). The reviewer would have been looser on ${r.looser}, tighter on ${r.tighter}.`,
    `Cost: ${usd(r.costUsd)}${r.unpriced ? ` (${r.unpriced} review(s) on a model with no price are not counted)` : ""}`,
    "",
    "Real decision (rows) against what the reviewer would have said (columns)",
    ["", ...POLICIES].map((c) => c.padEnd(8)).join(" "),
    ...POLICIES.map((real) =>
      [real, ...POLICIES.map((shadow) => String(r.matrix[real][shadow]))]
        .map((c) => c.padEnd(8))
        .join(" "),
    ),
    "",
    "By model",
    ...r.byModel.map(
      (m) =>
        `  ${m.model}: ${m.reviews} reviews, ${pct(m.agreed, m.reviews)} agreed, ${usd(m.costUsd)}${m.unpriced ? `, ${m.unpriced} unpriced` : ""}`,
    ),
  ];
  if (r.disagreements.length > 0) {
    const shown = r.disagreements.slice(-limit);
    lines.push(
      "",
      `Disagreements (${shown.length} of ${r.disagreements.length}, newest last)`,
    );
    for (const d of shown) {
      lines.push(
        `  ${d.ts.slice(0, 19).replace("T", " ")}  ${d.tool}  real ${d.real.policy} by ${d.real.by}, reviewer ${d.shadow.policy}${d.model ? ` (${d.model})` : ""}`,
        `    ${clip(d.argsMasked.replace(/\s+/g, " "), 100)}`,
      );
      if (d.shadow.reason) lines.push(`    "${d.shadow.reason}"`);
    }
  }
  return lines;
}

/** Returns the process exit code. */
export function auditShadowAction(
  dir: string,
  options: AuditShadowOptions,
  write: (line: string) => void,
  fail: (line: string) => void,
): number {
  for (const [flag, value] of [
    ["--since", options.since],
    ["--until", options.until],
  ] as const) {
    if (value && Number.isNaN(Date.parse(value))) {
      fail(`${flag} must be a date such as 2026-11-01.`);
      return 2;
    }
  }
  const report = shadowReport(readShadowRecords(dir), {
    session: options.session,
    since: options.since,
    until: options.until,
    model: options.model,
  });
  if (options.json) {
    write(JSON.stringify(report));
    return 0;
  }
  const limit = Number(options.limit);
  for (const line of formatShadowReport(
    report,
    Number.isFinite(limit) && limit > 0 ? limit : 20,
  )) {
    write(maskText(line).text);
  }
  return 0;
}
