import {
  approvalHeldResult,
  consumeLoopGrant,
  holdQuestion,
  LOOP_REPEAT_LIMIT,
  loopCallKey,
  repeatCount,
  repeatedCallResult,
  replanHoldResult,
} from "core/util/loopMode.js";

import { services } from "../services/index.js";
import { getSessionLoop } from "../session.js";

import { CLI_LOOP_TOOL_NAMES, commitLoop } from "./loopSession.js";

/**
 * Loop mode's changes to tool permissions in the CLI, as applyLoopHolds does
 * in the IDE (gui/src/redux/thunks/loopHolds.ts), so the loop never stalls on
 * a prompt:
 *
 * - a call the person allowed from an approval question runs, once;
 * - any other call that would ask is held as an approval question in the
 *   inbox and refused for now, so the item goes on (or reports waiting);
 * - in a re-plan, which only reads, such a call is refused;
 * - a call repeated LOOP_REPEAT_LIMIT times in the item's run is refused.
 *
 * Rules, protected paths, hooks and the reviewer decide first: only what
 * they leave for the person reaches holdLoopCall.
 */

interface CallLike {
  name: string;
  arguments: Record<string, unknown> | undefined;
}

export type LoopHoldResult =
  | { approved: true }
  | { approved: false; denialReason: "loop"; denialMessage: string };

/** A one-line description of a call for its approval question. */
export function loopCallSummary(call: CallLike): string {
  const args = call.arguments ?? {};
  for (const key of ["command", "filepath", "file_path", "path", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return `${call.name}: ${value.trim()}`.slice(0, 300);
    }
  }
  return call.name;
}

/**
 * A call that would ask for approval while the loop runs a step. Returns
 * undefined when no loop step is running, so the caller asks as usual.
 */
export function holdLoopCall(
  call: CallLike,
  reason?: string,
  now = new Date(),
): LoopHoldResult | undefined {
  let loop = getSessionLoop();
  const current = loop?.current;
  if (!loop || !current) return undefined;

  // The loop's own tools change no files; holding them would stall the item
  if (
    current.kind === "item" &&
    (call.name === CLI_LOOP_TOOL_NAMES.holdQuestion ||
      call.name === CLI_LOOP_TOOL_NAMES.finishItem)
  ) {
    return { approved: true };
  }

  if (current.kind === "replan") {
    return {
      approved: false,
      denialReason: "loop",
      denialMessage: replanHoldResult(CLI_LOOP_TOOL_NAMES),
    };
  }

  const key = loopCallKey(call.name, call.arguments);
  const grant = consumeLoopGrant(loop, key);
  if (grant.granted) {
    commitLoop(grant.loop);
    return { approved: true };
  }

  const summary = loopCallSummary(call);
  const held = holdQuestion(
    loop,
    {
      itemId: current.itemId,
      question: `Allow this call? ${summary}${reason ? ` (${reason})` : ""}`,
      kind: "approval",
      approval: { toolName: call.name, summary, grantKey: key },
      toolNames: CLI_LOOP_TOOL_NAMES,
    },
    now,
  );
  if (held.ok) {
    loop = held.loop;
    commitLoop(loop);
  }
  return {
    approved: false,
    denialReason: "loop",
    denialMessage: held.ok
      ? approvalHeldResult(held.question, CLI_LOOP_TOOL_NAMES)
      : `This call needs the person's approval and was not run. ${held.error}`,
  };
}

/**
 * The repeat limit for one batch of tool calls: `batchIds` are the batch's
 * own calls, already in the history, which are counted as they are checked.
 * Only the main session's item runs count; a subagent's history is its own.
 */
export function loopRepeatGuard(batchIds: string[]): {
  check: (call: CallLike) => string | undefined;
} {
  const loop = getSessionLoop();
  const current = loop?.current;
  const svc = services.chatHistory;
  const main = typeof svc?.isReady === "function" && svc.isReady();
  if (current?.kind !== "item" || !main) {
    return { check: () => undefined };
  }
  const batch = new Set(batchIds);
  const previous = svc
    .getHistory()
    .slice(current.historyIndex)
    .flatMap((item) => item.toolCallStates ?? [])
    .filter((tc) => !batch.has(tc.toolCallId))
    .map((tc) => loopCallKey(tc.toolCall.function.name, tc.parsedArgs ?? {}));
  return {
    check: (call) => {
      const key = loopCallKey(call.name, call.arguments);
      const count = repeatCount(previous, key);
      previous.push(key);
      return count >= LOOP_REPEAT_LIMIT
        ? repeatedCallResult(count, CLI_LOOP_TOOL_NAMES)
        : undefined;
    },
  };
}
