import {
  approvalHeldResult,
  consumeLoopGrant,
  describeHeldCall,
  FINISH_ITEM_TOOL_NAME,
  HOLD_QUESTION_TOOL_NAME,
  itemTurnLimitReport,
  itemTurnLimitResult,
  itemTurnState,
  holdQuestion,
  LOOP_REPEAT_LIMIT,
  REPLAN_HOLD_RESULT,
  repeatCount,
  repeatedCallResult,
} from "core/util/loopMode";
import { grantKey } from "../slices/blockedCallsSlice";
import { errorToolCall, updateToolCallOutput } from "../slices/sessionSlice";
import { AppThunkDispatch, RootState } from "../store";
import { commitLoop } from "../util/loopCommit";
import { EvaluatedPolicy } from "./evaluateToolPolicies";

function refuse(
  dispatch: AppThunkDispatch,
  toolCallId: string,
  description: string,
  content: string,
) {
  dispatch(errorToolCall({ toolCallId }));
  dispatch(
    updateToolCallOutput({
      toolCallId,
      contextItems: [
        {
          icon: "problems",
          name: "Loop mode",
          description,
          content,
          hidden: false,
        },
      ],
    }),
  );
}

/** Model requests the running item has made so far. */
function itemTurns(state: RootState, historyIndex: number): number {
  return state.session.history
    .slice(historyIndex)
    .filter((item) => item.message.role === "assistant").length;
}

/**
 * True when the running item has gone past its turn limit and kept calling
 * tools: records the run as stuck, and the caller ends the turn.
 */
export function endRunAtTurnLimit(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
): boolean {
  const { loop } = getState().session;
  if (loop?.current?.kind !== "item") return false;
  const turns = itemTurns(getState(), loop.current.historyIndex);
  if (itemTurnState(loop, turns) !== "end") return false;
  commitLoop(dispatch, getState, {
    ...loop,
    current: { ...loop.current, report: itemTurnLimitReport(turns) },
  });
  return true;
}

/**
 * Loop mode's changes to the policy results, so the loop never stalls on a
 * prompt:
 *
 * - a call the person allowed from an approval question runs, once;
 * - any other call that would wait for approval is held as an approval
 *   question in the inbox and refused for now, so the item goes on (or
 *   reports waiting) and other items run;
 * - in a re-plan turn, which only reads, such a call is refused;
 * - a call repeated LOOP_REPEAT_LIMIT times in the item's run is refused;
 * - past the item's turn limit, tools that only read are refused.
 *
 * Refused calls come back as "disabled", which the caller treats as done.
 */
export function applyLoopHolds(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  policies: EvaluatedPolicy[],
): EvaluatedPolicy[] {
  let loop = getState().session.loop;
  const current = loop?.current;
  if (!loop || !current) return policies;

  const newIds = new Set(policies.map((p) => p.toolCallState.toolCallId));
  const previous = getState()
    .session.history.slice(current.historyIndex)
    .flatMap((item) => item.toolCallStates ?? [])
    .filter((tc) => !newIds.has(tc.toolCallId))
    .map((tc) => grantKey(tc.toolCall.function.name, tc.parsedArgs ?? {}));

  const turns = itemTurns(getState(), current.historyIndex);
  const startLoop = loop;
  const result = policies.map((p): EvaluatedPolicy => {
    if (p.policy === "disabled") return p;
    const { toolCallState } = p;
    const name = toolCallState.toolCall.function.name;
    const key = grantKey(name, toolCallState.parsedArgs ?? {});

    if (
      current.kind === "item" &&
      name !== HOLD_QUESTION_TOOL_NAME &&
      name !== FINISH_ITEM_TOOL_NAME &&
      // Only reading stops: research already done must still get written
      toolCallState.tool?.readonly &&
      startLoop &&
      itemTurnState(startLoop, turns) === "wrap-up"
    ) {
      refuse(
        dispatch,
        toolCallState.toolCallId,
        "Turn limit reached",
        itemTurnLimitResult(turns),
      );
      return { ...p, policy: "disabled" };
    }
    if (current.kind === "item") {
      const count = repeatCount(previous, key);
      previous.push(key);
      if (count >= LOOP_REPEAT_LIMIT) {
        refuse(
          dispatch,
          toolCallState.toolCallId,
          "Repeated call",
          repeatedCallResult(count),
        );
        return { ...p, policy: "disabled" };
      }
    }
    if (p.policy !== "allowedWithPermission" || !loop) return p;

    if (current.kind === "replan") {
      refuse(
        dispatch,
        toolCallState.toolCallId,
        "Not run while re-planning",
        REPLAN_HOLD_RESULT,
      );
      return { ...p, policy: "disabled" };
    }
    const grant = consumeLoopGrant(loop, key);
    if (grant.granted) {
      loop = grant.loop;
      return {
        ...p,
        policy: "allowedWithoutPermission",
        source: "once",
        reason: "You allowed this call from the loop's inbox.",
      };
    }
    const summary = (
      p.displayValue || describeHeldCall(name, toolCallState.parsedArgs)
    ).slice(0, 300);
    const held = holdQuestion(
      loop,
      {
        itemId: current.itemId,
        question: `Allow this call? ${summary}${p.reason ? ` (${p.reason})` : ""}`,
        kind: "approval",
        approval: { toolName: name, summary, grantKey: key },
      },
      new Date(),
    );
    if (held.ok) loop = held.loop;
    refuse(
      dispatch,
      toolCallState.toolCallId,
      "Held for your approval",
      held.ok
        ? approvalHeldResult(held.question)
        : `This call needs the person's approval and was not run. ${held.error}`,
    );
    return { ...p, policy: "disabled" };
  });
  if (loop !== getState().session.loop) commitLoop(dispatch, getState, loop);
  return result;
}
