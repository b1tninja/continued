import type { ToolCallState } from "core";
import type { RootState } from "../store";

/**
 * The present_plan call whose decisions the person can still answer, or
 * undefined: the latest one, while the person has said nothing since (or while
 * the loop waits on it as a re-plan). The same test the plan card uses to show
 * its buttons, so the Questions panel and the card never disagree.
 */
export function selectPlanCallToDecide(
  state: RootState,
): ToolCallState | undefined {
  const { history, isStreaming, loop } = state.session;
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i].toolCallStates?.find(
      (tc) => tc.toolCall.function.name === "present_plan",
    );
    if (!call) continue;
    if (call.status !== "done") return undefined;
    if (call.output?.[0]?.uri?.type !== "file") return undefined;
    const awaitingLoop = loop?.status === "awaiting_plan";
    const loopActive = !!loop && loop.status !== "stopped";
    const answered = history
      .slice(i + 1)
      .some((item) => item.message.role === "user");
    const actionable =
      (!answered && !isStreaming && !loopActive) || awaitingLoop;
    return actionable ? call : undefined;
  }
  return undefined;
}
