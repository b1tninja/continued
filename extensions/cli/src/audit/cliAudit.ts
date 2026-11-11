import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import { mainAuditAgent } from "core/tools/permissions/audit/identity.js";
import type { AuditAgent } from "core/tools/permissions/audit/record.js";
import type { AuditTrail } from "core/tools/permissions/audit/trail.js";

import { getCurrentSession } from "../session.js";
import { logger } from "../util/logger.js";

/**
 * The CLI's side of the audit trail (plans/reviewer-audit.md, P12c): the call's
 * decision from the permission path and its outcome from the tool result path,
 * joined by the call id. Nothing here throws; the trail itself reports a
 * failed write once and carries on.
 */
export function cliAuditTrail(): AuditTrail {
  return getAuditTrail((message) => logger.warn(message));
}

export function cliAuditSession(): string {
  try {
    return getCurrentSession().sessionId || "cli";
  } catch {
    return "cli";
  }
}

let currentAgent: AuditAgent | undefined;

/**
 * Who this process is for the audit record: a Loop worker names itself
 * (loopWorker.ts); anything else is the session's main agent. The ids are
 * the agent map's, so a record joins to a node.
 */
export function setCliAuditAgent(agent: AuditAgent | undefined): void {
  currentAgent = agent;
}

export function cliAuditAgent(): AuditAgent {
  return currentAgent ?? mainAuditAgent(cliAuditSession());
}

/** What the permission path learned while deciding one call. */
export interface ApprovalTrace {
  /** The core engine's verdict, when it applied */
  verdict?: {
    decision: "allow" | "ask" | "deny";
    by: "rules" | "reviewer" | "system";
    source?: string;
    rule?: string;
    reason?: string;
    reviewer?: Record<string, unknown>;
  };
  /** A person was asked (a prompt was shown) */
  askedPerson?: boolean;
  /** Loop mode held the call as a question */
  held?: boolean;
  /** The role the tool table applied (core/tools/roleTools.ts) */
  role?: string;
}

export function recordCliDecision(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  trace: ApprovalTrace,
  result: { approved: boolean; denialMessage?: string },
): void {
  try {
    const trail = cliAuditTrail();
    if (!trail.enabled) return;
    const v = trace.verdict;
    const asked = trace.askedPerson || trace.held;
    const base = {
      session: cliAuditSession(),
      agent: {
        ...cliAuditAgent(),
        ...(trace.role ? { toolRole: trace.role } : {}),
      },
      callId: call.id,
      tool: call.name,
      args: safeJson(call.arguments),
      by: v?.by ?? "rules",
      source: v?.source ?? (v ? undefined : "cli-policy"),
      rule: v?.rule,
      reviewer: v?.reviewer as never,
    } as const;
    if (asked) {
      trail.decision({
        ...base,
        policy: "ask",
        reason: v?.reason ?? "The call needs approval.",
      });
      if (trace.askedPerson) trail.answer(call.id, result.approved);
      return;
    }
    trail.decision({
      ...base,
      policy: result.approved ? "allow" : "deny",
      reason: v?.reason ?? result.denialMessage,
    });
  } catch {
    // the audit never blocks a call
  }
}

export function recordCliOutcome(
  call: { id: string; name: string },
  outcome: {
    ran: boolean;
    exit?: number;
    output?: string;
    error?: string;
    durMs?: number;
  },
): void {
  try {
    const trail = cliAuditTrail();
    if (!trail.enabled) return;
    trail.outcome({ callId: call.id, tool: call.name, ...outcome });
  } catch {
    // the audit never blocks a call
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
