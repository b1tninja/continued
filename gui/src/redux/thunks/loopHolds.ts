import {
  approvalHeldResult,
  consumeLoopGrant,
  holdQuestion,
  LOOP_REPEAT_LIMIT,
  loopGrantKey,
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

/**
 * Loop mode's changes to the policy results, so the loop never stalls on a
 * prompt:
 *
 * - a call the person allowed from an approval question runs, once;
 * - any other call that would wait for approval is held as an approval
 *   question in the inbox and refused for now, so the item goes on (or
 *   reports waiting) and other items run;
 * - in a re-plan turn, which only reads, such a call is refused;
 * - a call repeated LOOP_REPEAT_LIMIT times in the item's run is refused.
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

  const result = policies.map((p): EvaluatedPolicy => {
    if (p.policy === "disabled") return p;
    const { toolCallState } = p;
    const name = toolCallState.toolCall.function.name;
    const key = grantKey(name, toolCallState.parsedArgs ?? {});

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
    // A grant covers what the question names (the file, the command)
    const grantFor = loopGrantKey(name, toolCallState.parsedArgs ?? {});
    const grant = consumeLoopGrant(loop, grantFor);
    if (grant.granted) {
      loop = grant.loop;
      return {
        ...p,
        policy: "allowedWithoutPermission",
        source: "once",
        reason: "You allowed this call from the loop's inbox.",
      };
    }
    const summary = (p.displayValue || name).slice(0, 300);
    const held = holdQuestion(
      loop,
      {
        itemId: current.itemId,
        question: `Allow this call? ${summary}${p.reason ? ` (${p.reason})` : ""}`,
        kind: "approval",
        approval: { toolName: name, summary, grantKey: grantFor },
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
