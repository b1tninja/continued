/**
 * The tainted-session flag (plans/design/tainted-session.md, ROADMAP X4).
 *
 * Per session, a monotone set of source kinds: once untrusted content has
 * entered the conversation, the kind stays recorded (with the turn it first
 * entered) until the person clears it. Nothing about the content is kept: not
 * the text, not the URL, not a hash. The state is a few bytes per session.
 */
export const TAINT_KINDS = [
  "web-fetch",
  "mcp-result",
  "outside-read",
  "untrusted-workspace",
  "issue-text",
] as const;
export type TaintKind = (typeof TAINT_KINDS)[number];

/** What the evaluator, the reviewer prompt and the audit record are given. */
export interface TaintFact {
  /** Source kinds in a fixed order */
  kinds: TaintKind[];
  /** The turn the first source entered, when the host counts turns */
  firstTurn?: number;
}

/** What ends a taint: the person's own action, or a new session. */
export type TaintClearReason = "user-ack" | "untaint-command" | "new-session";

/** How a label arrived: a tool's result, a subagent handing it back, or a fork. */
export type TaintAddReason = "tool-result" | "subagent" | "inherited";

/**
 * One label added to or cleared from a session, for the audit trail. `source`
 * is the tool that brought the content in (an add) or the control that
 * cleared it (a clear).
 */
export interface TaintChange {
  session: string;
  op: "add" | "clear";
  label: TaintKind;
  turn?: number;
  source?: string;
  reason: TaintAddReason | TaintClearReason;
}

interface Entry {
  turn?: number;
  /** Copied from a parent at fork: a join does not hand it back */
  inherited: boolean;
}

type SessionTaint = Map<TaintKind, Entry>;

const MAX_BOUND_CALLS = 500;
/** A host with no session id of its own shares this one */
export const DEFAULT_TAINT_SESSION = "default";

export class TaintRegistry {
  private readonly sessions = new Map<string, SessionTaint>();
  private readonly callSession = new Map<string, string>();
  private listener?: (change: TaintChange) => void;

  /** Who hears of every add and clear (the audit trail). One at a time. */
  setListener(listener: ((change: TaintChange) => void) | undefined): void {
    this.listener = listener;
  }

  private emit(change: TaintChange): void {
    try {
      this.listener?.(change);
    } catch {
      // the record is a nicety; it never changes the taint
    }
  }

  /** Add a source. Returns true when this kind was not already recorded. */
  mark(
    session: string,
    kind: TaintKind,
    turn?: number,
    origin: { source?: string; reason?: TaintAddReason } = {},
  ): boolean {
    let entries = this.sessions.get(session);
    if (!entries) this.sessions.set(session, (entries = new Map()));
    if (entries.has(kind)) return false;
    entries.set(kind, {
      inherited: false,
      ...(turn === undefined ? {} : { turn }),
    });
    this.emit({
      session,
      op: "add",
      label: kind,
      ...(turn === undefined ? {} : { turn }),
      ...(origin.source ? { source: origin.source } : {}),
      reason: origin.reason ?? "tool-result",
    });
    return true;
  }

  fact(session: string): TaintFact | undefined {
    const entries = this.sessions.get(session);
    if (!entries || entries.size === 0) return undefined;
    const kinds = TAINT_KINDS.filter((k) => entries.has(k));
    const turns = [...entries.values()]
      .map((e) => e.turn)
      .filter((t): t is number => t !== undefined);
    return {
      kinds,
      ...(turns.length ? { firstTurn: Math.min(...turns) } : {}),
    };
  }

  /**
   * Clear the session. Returns the kinds that were cleared; each is reported
   * to the listener with the reason and the control that cleared it.
   */
  clear(
    session: string,
    reason: TaintClearReason,
    source?: string,
  ): TaintKind[] {
    const cleared = this.fact(session)?.kinds ?? [];
    this.sessions.delete(session);
    for (const label of cleared) {
      this.emit({
        session,
        op: "clear",
        label,
        reason,
        ...(source ? { source } : {}),
      });
    }
    return cleared;
  }

  /** A child agent that has its own session id starts as tainted as its parent. */
  fork(parent: string, child: string): void {
    const from = this.sessions.get(parent);
    if (!from || from.size === 0) return;
    const copy: SessionTaint = new Map();
    for (const [kind, e] of from) copy.set(kind, { ...e, inherited: true });
    this.sessions.set(child, copy);
    for (const [kind, e] of copy) {
      this.emit({
        session: child,
        op: "add",
        label: kind,
        ...(e.turn === undefined ? {} : { turn: e.turn }),
        source: parent,
        reason: "inherited",
      });
    }
  }

  /** What the child met comes back to the parent; what it only inherited does not. */
  join(child: string, parent: string): void {
    const from = this.sessions.get(child);
    if (!from) return;
    for (const [kind, e] of from) {
      if (!e.inherited) {
        this.mark(parent, kind, e.turn, { source: child, reason: "subagent" });
      }
    }
  }

  /** The call's session, so a result that carries only a call id finds it. */
  bindCall(callId: string, session: string): void {
    this.callSession.delete(callId);
    this.callSession.set(callId, session);
    while (this.callSession.size > MAX_BOUND_CALLS) {
      const oldest = this.callSession.keys().next().value;
      if (oldest === undefined) break;
      this.callSession.delete(oldest);
    }
  }

  sessionOfCall(callId: string | undefined): string | undefined {
    return callId === undefined ? undefined : this.callSession.get(callId);
  }

  reset(): void {
    this.sessions.clear();
    this.callSession.clear();
  }
}

export const taintRegistry = new TaintRegistry();
