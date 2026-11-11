import {
  detectStuck,
  type StuckCall,
  type StuckReport,
  type StuckStep,
} from "../../../util/stuckSignals";
import type {
  AuditAgent,
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
 *  - Agents: the steps are of one agent (default the main agent, which a
 *    record with no `agent` is too); `auditToAgentSteps` gives every agent's.
 *  - A call that did not run (denied, or never started) is a failed call whose
 *    result is the error line if there is one, else "not run".
 */
export function auditToSteps(
  records: readonly AuditRecord[],
  agent: string = MAIN_AGENT,
): StuckStep[] {
  return auditToAgentSteps(records).get(agent) ?? [];
}

/** The key of the main agent in `auditToAgentSteps`; see `agentKeyOf`. */
export const MAIN_AGENT = "main";

/**
 * The agent a record belongs to. A record with no `agent` (written before
 * #576, or by a host that does not say) and one of kind "main" are the same
 * agent, `MAIN_AGENT`, whatever the session id in the main id is; every other
 * agent is its own id.
 */
export function agentKeyOf(agent: AuditAgent | undefined): string {
  if (!agent || agent.kind === "main") return MAIN_AGENT;
  return agent.id;
}

/**
 * The steps of every agent in the records, by agent key. Turn numbers are an
 * agent's own (a subagent's first turn is not the main agent's first), so
 * steps are formed inside an agent and never across agents; and an agent's
 * steps hold only its own calls, so one agent's repeats are not hidden by
 * another's calls and are not charged to it.
 */
export function auditToAgentSteps(
  records: readonly AuditRecord[],
): Map<string, StuckStep[]> {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const decisions = new Map<string, DecisionEvent>();
  const groups = new Map<string, AgentRecords>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { outcomes: [], turns: [] }));
    return g;
  };
  for (const r of ordered) {
    if (r.ev === "decision") {
      // an ask answered by the person writes a second decision: the later wins
      decisions.set(r.callId, r);
    } else if (r.ev === "outcome") {
      // the outcome may omit the agent its decision named
      const agent = r.agent ?? decisions.get(r.callId)?.agent;
      group(agentKeyOf(agent)).outcomes.push(r);
    } else if (r.ev === "turn") group(agentKeyOf(r.agent)).turns.push(r);
  }
  const out = new Map<string, StuckStep[]>();
  for (const [key, g] of groups) {
    const steps = stepsOf(g, decisions);
    if (steps.length > 0) out.set(key, steps);
  }
  return out;
}

interface AgentRecords {
  outcomes: OutcomeEvent[];
  turns: TurnEvent[];
}

/** What stuck detection says of each agent that has steps. */
export function detectStuckByAgent(
  records: readonly AuditRecord[],
): { agent: string; report: StuckReport }[] {
  return [...auditToAgentSteps(records)].map(([agent, steps]) => ({
    agent,
    report: detectStuck(steps),
  }));
}

function stepsOf(
  { outcomes, turns }: AgentRecords,
  decisions: Map<string, DecisionEvent>,
): StuckStep[] {
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
