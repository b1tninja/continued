import type { StuckCall, StuckStep } from "../../../util/stuckSignals";
import type {
  AuditRecord,
  DecisionEvent,
  OutcomeEvent,
  TurnEvent,
} from "./record";

/**
 * The audit trail as stuck-detection input (plans/reviewer-audit.md, section 8).
 * The work log of Track S is a view over what the agent did; `buildWorkLog` and
 * `detectStuck` read `StuckStep[]`, which the history adapters build from a chat
 * history. This builds the same steps from audit records, so a host that writes
 * an audit needs no second copy of its history.
 *
 * What carries over, and what does not:
 *  - Calls, their arguments, files changed (with the content hash after) and
 *    files read: exact, so near-repeat, ping-pong, edit-revert and the
 *    repeat-since-last-change rule behave as on the history.
 *  - Output: the audit keeps no output text. An ok call's `result` is the hash
 *    of its masked output, so "the same observation again" is still equality;
 *    a failed call's `result` is the normalised first error line. The
 *    repeat-error signal compares that line and so is as exact as the line is.
 *    Where two outputs differ only after their first line, or only in a masked
 *    span, the signals see one observation.
 *  - Assistant text: the audit keeps its length only, so a text-only turn is a
 *    step with no text and the monologue signal cannot fire from an audit.
 *  - A call that did not run (denied, or never started) is a failed call whose
 *    result is the error line if there is one, else "not run".
 */
export function auditToSteps(records: readonly AuditRecord[]): StuckStep[] {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const decisions = new Map<string, DecisionEvent>();
  const outcomes: OutcomeEvent[] = [];
  const turns: TurnEvent[] = [];
  for (const r of ordered) {
    if (r.ev === "decision") {
      // an ask answered by the person writes a second decision: the later wins
      decisions.set(r.callId, r);
    } else if (r.ev === "outcome") outcomes.push(r);
    else turns.push(r);
  }

  // Steps in order of turn; a record with no turn is a step of its own.
  const byTurn = new Map<string, StuckCall[]>();
  const stepOrder: string[] = [];
  const touch = (key: string) => {
    if (!byTurn.has(key)) {
      byTurn.set(key, []);
      stepOrder.push(key);
    }
    return byTurn.get(key)!;
  };
  const textOnly = new Set<string>();

  const entries: { seq: number; key: string; call?: StuckCall }[] = [];
  for (const o of outcomes) {
    const key = o.turn === undefined ? `seq:${o.seq}` : `turn:${o.turn}`;
    entries.push({ seq: o.seq, key, call: callOf(o, decisions.get(o.callId)) });
  }
  for (const t of turns) {
    if (t.calls === 0 && t.textChars > 0) {
      const key = t.turn === undefined ? `seq:${t.seq}` : `turn:${t.turn}`;
      entries.push({ seq: t.seq, key });
      textOnly.add(key);
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  for (const e of entries) {
    const calls = touch(e.key);
    if (e.call) calls.push(e.call);
  }

  return stepOrder
    .map((key) => ({ key, calls: byTurn.get(key)! }))
    .filter((s) => s.calls.length > 0 || textOnly.has(s.key))
    .map((s) => ({ calls: s.calls }));
}

function argsOf(decision: DecisionEvent | undefined): Record<string, unknown> {
  if (!decision) return {};
  try {
    const parsed = JSON.parse(decision.argsMasked);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // clipped or not JSON: the text itself is the identity
  }
  return { raw: decision.argsMasked };
}

function callOf(
  o: OutcomeEvent,
  decision: DecisionEvent | undefined,
): StuckCall {
  const failed =
    !o.ran ||
    (o.exit !== undefined && o.exit !== 0) ||
    (o.exit === undefined && o.errSig !== undefined);
  const result = failed ? (o.errSig ?? "not run") : (o.outHash ?? "");
  return {
    tool: o.tool,
    args: argsOf(decision),
    result,
    ...(failed ? { error: true } : {}),
    ...(o.changed?.length ? { changed: o.changed } : {}),
    ...(o.read?.length ? { read: o.read } : {}),
  };
}
