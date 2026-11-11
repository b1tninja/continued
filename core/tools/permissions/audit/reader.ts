import fs from "node:fs";
import path from "node:path";
import type {
  AuditAgent,
  AuditRecord,
  DecisionEvent,
  OutcomeEvent,
} from "./record";
import { readAuditFile } from "./writer";

/**
 * Reading the audit directory back (plans/reviewer-audit.md, P12d): the files
 * `AuditWriter` wrote, joined into one row per call, and the prune the
 * retention setting asks for.
 */
export interface AuditFileInfo {
  file: string;
  /** yyyy-mm */
  month: string;
  session: string;
  index: number;
  bytes: number;
  mtimeMs: number;
}

const FILE_RE = /^(.*?)(?:\.(\d+))?\.jsonl$/;

/** Every audit file under `dir`, oldest month first, a session's parts in order. */
export function listAuditFiles(dir: string): AuditFileInfo[] {
  const out: AuditFileInfo[] = [];
  let months: string[];
  try {
    months = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const month of months.filter((m) => /^\d{4}-\d{2}$/.test(m)).sort()) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, month));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const file = path.join(dir, month, name);
      try {
        const st = fs.statSync(file);
        out.push({
          file,
          month,
          session: m[1],
          index: m[2] ? Number(m[2]) : 0,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.session.localeCompare(b.session) ||
      a.index - b.index,
  );
}

/** All records of one session, across months and rotated parts, in order. */
export function readAuditSession(dir: string, session: string): AuditRecord[] {
  return listAuditFiles(dir)
    .filter((f) => f.session === session)
    .flatMap((f) => readAuditFile(f.file));
}

export interface AuditCallRow {
  session: string;
  callId: string;
  tool: string;
  /** Time of the first decision */
  ts: string;
  /** The final decision: the person's answer or the reviewer's, when there was one */
  policy: DecisionEvent["policy"];
  by: DecisionEvent["by"];
  /** An earlier decision for the call was an ask */
  asked: boolean;
  source?: string;
  rule?: string;
  reason?: string;
  reviewerModel?: string;
  argsMasked: string;
  /** Which agent made the call; absent for a record that predates it */
  agent?: AuditAgent;
  ran?: boolean;
  exit?: number;
  durMs?: number;
  decisions: DecisionEvent[];
  outcome?: OutcomeEvent;
}

/** One row per call, from a session's records. An outcome with no decision is skipped. */
export function callRows(records: readonly AuditRecord[]): AuditCallRow[] {
  const byCall = new Map<string, AuditCallRow>();
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  for (const r of ordered) {
    if (r.ev === "decision") {
      const row = byCall.get(r.callId);
      if (!row) {
        byCall.set(r.callId, {
          session: r.session,
          callId: r.callId,
          tool: r.tool,
          ts: r.ts,
          policy: r.policy,
          by: r.by,
          asked: r.policy === "ask",
          source: r.source,
          rule: r.rule,
          reason: r.reason,
          reviewerModel: r.reviewer?.model,
          argsMasked: r.argsMasked,
          ...(r.agent ? { agent: r.agent } : {}),
          decisions: [r],
        });
      } else {
        row.asked ||= row.policy === "ask";
        row.policy = r.policy;
        row.by = r.by;
        row.source = r.source ?? row.source;
        row.rule = r.rule ?? row.rule;
        row.reason = r.reason ?? row.reason;
        row.reviewerModel = r.reviewer?.model ?? row.reviewerModel;
        row.decisions.push(r);
      }
    } else if (r.ev === "outcome") {
      const row = byCall.get(r.callId);
      if (!row) continue;
      row.outcome = r;
      row.ran = r.ran;
      row.exit = r.exit;
      row.durMs = r.durMs;
    }
  }
  return [...byCall.values()];
}

export interface AuditFilter {
  session?: string;
  /** allow, ask, deny, or reviewer */
  decision?: string;
  tool?: string;
  /** An agent's role, id or kind ("Explore", "sub-call_1", "loop-worker") */
  agent?: string;
  /** Inclusive, ISO date or timestamp */
  since?: string;
  /** Inclusive, ISO date or timestamp; a bare date covers that whole day */
  until?: string;
}

export const DECISION_FILTERS = ["allow", "ask", "deny", "reviewer"] as const;

function endOfDay(until: string): number {
  const t = Date.parse(until);
  return /^\d{4}-\d{2}-\d{2}$/.test(until) ? t + 24 * 3600 * 1000 - 1 : t;
}

export function matchesFilter(row: AuditCallRow, f: AuditFilter): boolean {
  if (f.session && row.session !== f.session) return false;
  if (f.tool && row.tool !== f.tool) return false;
  if (f.agent) {
    const a = row.agent;
    if (!a || (a.role !== f.agent && a.id !== f.agent && a.kind !== f.agent)) {
      return false;
    }
  }
  if (f.decision) {
    const d = f.decision;
    const hit =
      d === "reviewer"
        ? row.decisions.some((x) => x.by === "reviewer")
        : d === "ask"
          ? row.asked || row.policy === "ask"
          : row.policy === d;
    if (!hit) return false;
  }
  const t = Date.parse(row.ts);
  if (f.since && t < Date.parse(f.since)) return false;
  if (f.until && t > endOfDay(f.until)) return false;
  return true;
}

/** Rows of the whole directory (or one session) that pass the filter, oldest first. */
export function listCalls(dir: string, f: AuditFilter = {}): AuditCallRow[] {
  const bySession = new Map<string, AuditRecord[]>();
  for (const file of listAuditFiles(dir)) {
    if (f.session && file.session !== f.session) continue;
    const list = bySession.get(file.session) ?? [];
    list.push(...readAuditFile(file.file));
    bySession.set(file.session, list);
  }
  return [...bySession.values()]
    .flatMap((records) => callRows(records))
    .filter((row) => matchesFilter(row, f))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface PruneResult {
  deleted: string[];
  bytes: number;
}

/** Delete whole files last written more than `retentionDays` ago, and empty month folders. */
export function pruneAudit(
  dir: string,
  opts: { retentionDays: number; now?: Date; dryRun?: boolean },
): PruneResult {
  const cutoff =
    (opts.now ?? new Date()).getTime() - opts.retentionDays * 24 * 3600 * 1000;
  const deleted: string[] = [];
  let bytes = 0;
  for (const f of listAuditFiles(dir)) {
    if (f.mtimeMs >= cutoff) continue;
    try {
      if (!opts.dryRun) fs.unlinkSync(f.file);
      deleted.push(f.file);
      bytes += f.bytes;
    } catch {
      // in use or already gone
    }
  }
  if (!opts.dryRun) {
    for (const monthDir of new Set(deleted.map((d) => path.dirname(d)))) {
      try {
        fs.rmdirSync(monthDir);
      } catch {
        // not empty
      }
    }
  }
  return { deleted, bytes };
}
