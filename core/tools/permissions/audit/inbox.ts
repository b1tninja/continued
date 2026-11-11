import { listCalls, type AuditCallRow, type AuditFilter } from "./reader";
import type { AuditAgent } from "./record";

/**
 * The Inbox slice of the audit (ROADMAP Track O and X): the calls that asked
 * and have not been answered, each with the agent that is waiting. Built from
 * rows the reader already joined, so every field was masked when written.
 *
 * "Waiting" is a call whose last decision is an ask and that has no outcome.
 * A session that ended with an ask open (a crash, a closed window) looks the
 * same, which is why each item carries its age and the list can be cut by it.
 */
export interface InboxItem {
  session: string;
  callId: string;
  tool: string;
  /** What the call would do, masked and clipped */
  summary: string;
  /** When the ask was written */
  askedAt: string;
  /** Why it asked, when the rules or the reviewer said */
  reason?: string;
  agent?: AuditAgent;
}

const SUMMARY_CHARS = 120;

export function inboxItems(
  rows: readonly AuditCallRow[],
  opts: { now?: Date; maxAgeMs?: number } = {},
): InboxItem[] {
  const now = (opts.now ?? new Date()).getTime();
  return rows
    .filter((r) => r.policy === "ask" && r.outcome === undefined)
    .filter((r) => {
      if (opts.maxAgeMs === undefined) return true;
      return now - Date.parse(r.ts) <= opts.maxAgeMs;
    })
    .map((r) => ({
      session: r.session,
      callId: r.callId,
      tool: r.tool,
      summary: r.argsMasked.replace(/\s+/g, " ").slice(0, SUMMARY_CHARS),
      askedAt: r.ts,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.agent ? { agent: r.agent } : {}),
    }))
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

/** The open asks in the audit directory, oldest first. */
export function listInbox(
  dir: string,
  filter: AuditFilter = {},
  opts: { now?: Date; maxAgeMs?: number } = {},
): InboxItem[] {
  return inboxItems(listCalls(dir, filter), opts);
}

/** "Explore (sub-call_1) under main-s1", for a line of text. */
export function describeAgent(agent: AuditAgent | undefined): string {
  if (!agent) return "unknown agent";
  const name = agent.role ?? agent.kind;
  const mode = agent.mode ? ` [${agent.mode}]` : "";
  const parent = agent.parentId ? ` under ${agent.parentId}` : "";
  return `${name}${mode}${parent}`;
}
