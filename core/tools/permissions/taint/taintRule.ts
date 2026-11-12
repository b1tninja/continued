import type { ToolPolicyResult, EvaluateInput } from "../evaluate";
import { sinkOfCall, type Sink } from "./taintSinks";
import type { TaintFact } from "./taintState";

/**
 * The tainted-session rule as a deterministic step after every other check:
 * when untrusted content has entered the session and the call is a sink, an
 * allow becomes an ask. It only raises. A refusal, a floor rule, a protected
 * path and a call that already asks are returned as they are, and no level,
 * rule or reviewer verdict later turns the ask back into an allow (the Auto
 * handler lists `tainted-session` among the sources it cannot move).
 * plans/design/tainted-session.md.
 */
export const TAINTED_SESSION_SOURCE = "tainted-session" as const;

export interface TaintedSessionInput {
  /** Set by the host only when `taintedSessionRule` is `ask` and the session is tainted */
  taint?: TaintFact;
}

export function reasonOf(sink: Sink, taint: TaintFact): string {
  const via = taint.kinds.join(", ");
  return `Untrusted content (${via}) entered this session, and this call can send data out or change state (${sink.class}: ${sink.detail}), so it asks. Acknowledge the content to stop these asks.`;
}

/** Whether the rule applies to a call, without changing a result (the replay uses this). */
export function taintSinkFor(input: EvaluateInput): Sink | undefined {
  const { tool, toolName, parsedArgs, processedArgs } = input;
  return sinkOfCall({
    toolName,
    parsedArgs,
    tool,
    resolved: processedArgs?.resolvedPath as
      { isWithinWorkspace: boolean } | null | undefined,
    trustedDomains: input.trustedDomains,
    shell: input.shell,
  });
}

export function applyTaintedSessionRule(
  input: EvaluateInput & TaintedSessionInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { taint } = input;
  if (!taint || taint.kinds.length === 0) return result;
  const sink = taintSinkFor(input);
  if (!sink) return result;
  // Named on every result of a tainted session, so a replay can count the
  // calls the rule would ask on that already ask
  if (result.policy !== "allowedWithoutPermission") {
    return { ...result, taintSink: sink };
  }
  // The allow rule that matched would read as a contradiction beside the new reason
  const { rule: _allowRule, ...rest } = result;
  return {
    ...rest,
    policy: "allowedWithPermission",
    taintSink: sink,
    source: TAINTED_SESSION_SOURCE,
    reason: reasonOf(sink, taint),
  };
}
