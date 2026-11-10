/**
 * `continuous audit list|show <session>|prune`: read the audit trail the
 * permission path writes (plans/reviewer-audit.md, P12d). The files are
 * `<global dir>/audit/<yyyy-mm>/<session>.jsonl`; this only reads them, and
 * `prune` deletes whole files past the retention.
 */

import {
  auditDir,
  auditSettings,
} from "core/tools/permissions/audit/global.js";
import {
  callRows,
  DECISION_FILTERS,
  listCalls,
  matchesFilter,
  pruneAudit,
  readAuditSession,
  type AuditCallRow,
  type AuditFilter,
} from "core/tools/permissions/audit/reader.js";

export interface AuditCommandOptions {
  json?: boolean;
  session?: string;
  decision?: string;
  tool?: string;
  since?: string;
  until?: string;
  days?: string | number;
  dryRun?: boolean;
  /** Where the audit files are; defaults to the global directory */
  dir?: string;
  limit?: string | number;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function line(row: AuditCallRow): string {
  const who = row.reviewerModel ? `${row.by}:${row.reviewerModel}` : row.by;
  const ran =
    row.ran === undefined
      ? "-"
      : row.ran
        ? row.exit
          ? `exit ${row.exit}`
          : "ran"
        : "not run";
  return [
    row.ts.slice(0, 19).replace("T", " "),
    row.session.slice(0, 12).padEnd(12),
    row.policy.padEnd(5),
    clip(who, 28).padEnd(28),
    row.tool.padEnd(18),
    ran.padEnd(8),
    clip(row.argsMasked.replace(/\s+/g, " "), 60),
  ].join("  ");
}

function parseDays(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function filterOf(options: AuditCommandOptions): AuditFilter | string {
  if (
    options.decision &&
    !(DECISION_FILTERS as readonly string[]).includes(options.decision)
  ) {
    return `--decision must be one of ${DECISION_FILTERS.join(", ")}.`;
  }
  for (const [flag, value] of [
    ["--since", options.since],
    ["--until", options.until],
  ] as const) {
    if (value && Number.isNaN(Date.parse(value))) {
      return `${flag} must be a date such as 2026-11-01.`;
    }
  }
  return {
    session: options.session,
    decision: options.decision,
    tool: options.tool,
    since: options.since,
    until: options.until,
  };
}

/** Returns the process exit code. */
export function auditCommand(
  action: string | undefined,
  arg: string | undefined,
  options: AuditCommandOptions = {},
): number {
  const dir = options.dir ?? auditDir();
  switch (action ?? "list") {
    case "list": {
      const filter = filterOf(options);
      if (typeof filter === "string") {
        err(filter);
        return 2;
      }
      let rows = listCalls(dir, filter);
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-limit);
      if (options.json) {
        out(JSON.stringify(rows.map(({ decisions, outcome, ...r }) => r)));
        return 0;
      }
      if (rows.length === 0) {
        out("No audit records match.");
        return 0;
      }
      for (const row of rows) out(line(row));
      return 0;
    }
    case "show": {
      if (!arg) {
        err("Usage: continuous audit show <session>");
        return 2;
      }
      const filter = filterOf(options);
      if (typeof filter === "string") {
        err(filter);
        return 2;
      }
      const records = readAuditSession(dir, arg);
      if (records.length === 0) {
        err(`No audit records for session ${arg}.`);
        return 1;
      }
      if (options.json) {
        out(JSON.stringify(records));
        return 0;
      }
      const rows = callRows(records).filter((r) => matchesFilter(r, filter));
      for (const row of rows) {
        out(line(row));
        for (const d of row.decisions) {
          const detail = [
            `${d.policy} by ${d.by}`,
            d.source && `source ${d.source}`,
            d.rule && `rule ${d.rule}`,
            d.reviewer?.model && `model ${d.reviewer.model}`,
            d.reviewer?.latencyMs !== undefined && `${d.reviewer.latencyMs} ms`,
            d.reviewer?.usage &&
              `tokens ${d.reviewer.usage.input ?? "?"} in, ${d.reviewer.usage.output ?? "?"} out`,
            d.reason && `"${d.reason}"`,
          ].filter(Boolean);
          out(`    ${detail.join(", ")}`);
        }
      }
      return 0;
    }
    case "prune": {
      const days = parseDays(options.days) ?? auditSettings().retentionDays;
      const result = pruneAudit(dir, {
        retentionDays: days,
        dryRun: options.dryRun,
      });
      if (options.json) {
        out(JSON.stringify(result));
        return 0;
      }
      out(
        `${options.dryRun ? "Would delete" : "Deleted"} ${result.deleted.length} audit file(s), ${result.bytes} bytes, older than ${days} days.`,
      );
      return 0;
    }
    default:
      err(`Unknown audit action '${action}'. Use list, show or prune.`);
      return 2;
  }
}
