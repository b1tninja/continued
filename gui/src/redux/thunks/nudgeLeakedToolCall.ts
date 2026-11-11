import type { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { isLeakedToolCall } from "core/util/toolDialectLeak";
import {
  LEAKED_CALL_NUDGE,
  LEAKED_CALL_NUDGE_LIMIT,
  LEAKED_CALL_NUDGE_SESSION_LIMIT,
} from "core/util/turnEnd";
import type { AppThunkDispatch, RootState } from "../store";
import { addUserInputToHistory } from "./addUserInputToHistory";
import type { IIdeMessenger } from "../../context/IdeMessenger";

function isNudge(item: ChatHistoryItem): boolean {
  return (
    item.message.role === "user" &&
    renderChatMessage(item.message).includes(LEAKED_CALL_NUDGE)
  );
}

/** Nudges sent since the person's last own message: the turn's count. */
export function leakedCallNudgesThisTurn(history: ChatHistoryItem[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role !== "user") continue;
    if (!isNudge(history[i])) break;
    n++;
  }
  return n;
}

/** Nudges sent in the whole session, for the session cap. */
export function leakedCallNudgesThisSession(
  history: ChatHistoryItem[],
): number {
  return history.filter(isNudge).length;
}

/**
 * H13: a reply that is a tool call written as text ends the agent's turn with
 * nothing done. Say so to the model once per turn and let it answer: the nudge
 * goes into the history as a user message, as the loop's own nudges do. The
 * text is not parsed and nothing in it runs. A Loop run has its own nudge
 * (finishItemNudge), so it is left alone. Returns whether a nudge was added;
 * the caller then sends the request.
 */
export async function nudgeLeakedToolCall(args: {
  state: RootState;
  toolNames: string[];
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  ideMessenger: IIdeMessenger;
}): Promise<boolean> {
  const { history, loop } = args.state.session;
  // On unless the person turned it off (Settings, "Ask again when a tool
  // call is typed as text")
  if (args.state.config?.config?.ui?.nudgeLeakedToolCalls === false) {
    return false;
  }
  if (loop?.current) return false;
  const last = history.at(-1)?.message;
  if (last?.role !== "assistant" || (last.toolCalls?.length ?? 0) > 0) {
    return false;
  }
  if (
    leakedCallNudgesThisTurn(history) >= LEAKED_CALL_NUDGE_LIMIT ||
    leakedCallNudgesThisSession(history) >= LEAKED_CALL_NUDGE_SESSION_LIMIT
  ) {
    return false;
  }
  if (
    !isLeakedToolCall({
      content: renderChatMessage(last),
      knownTools: args.toolNames,
    })
  ) {
    return false;
  }
  await addUserInputToHistory({
    editorState: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: LEAKED_CALL_NUDGE }],
        },
      ],
    },
    modifiers: { noContext: true, useCodebase: false },
    index: args.getState().session.history.length,
    dispatch: args.dispatch,
    getState: args.getState,
    ideMessenger: args.ideMessenger,
  });
  return true;
}
