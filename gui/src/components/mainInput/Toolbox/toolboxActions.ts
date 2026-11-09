import type { Editor } from "@tiptap/react";
import type { ChatHistoryItem, LoopState, TaskPlan } from "core";
import { renderChatMessage } from "core/util/messageContent";
import type { ToolboxFacts } from "core/util/toolboxCards";
import type { AppThunkDispatch, RootState } from "../../../redux/store";

import { streamResponseThunk } from "../../../redux/thunks/streamResponse";

/** The session fields the facts are read from. */
export type ToolboxSession = Pick<
  RootState["session"],
  "history" | "loop" | "taskPlan"
>;

/** A plain document with one paragraph, as the input editor holds text. */
export function paragraphDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * Put a card's text in the input for editing: the editor takes focus at the
 * end, and the text goes after what is already there.
 */
export function insertToolboxText(editor: Editor | null, text: string): void {
  if (!editor) return;
  editor.commands.focus("end");
  editor.commands.insertContent(text);
}

/**
 * Send a card's text as the next message, as a Send in Agent mode. The text
 * does not come from the input, so what is in the input stays as it is.
 */
export function sendToolboxText(
  dispatch: AppThunkDispatch,
  text: string,
): Promise<unknown> {
  return dispatch(
    streamResponseThunk({
      editorState: paragraphDoc(text),
      modifiers: { noContext: true, useCodebase: false },
    }),
  );
}

/**
 * The facts a card can fill in from the session: the person's first request,
 * and the text of the running Loop item. The others (the last check, the last
 * error, the changed files, the open assumptions) are not read yet, so a card
 * that needs them drops those sentences.
 */
export function toolboxFactsFromState(session: ToolboxSession): ToolboxFacts {
  const facts: ToolboxFacts = {};
  const history: ChatHistoryItem[] = session.history;
  const first = history.find((item) => item.message.role === "user");
  if (first) facts.request = renderChatMessage(first.message);
  const item = runningItemText(session.loop, session.taskPlan);
  if (item) facts.item = item;
  return facts;
}

function runningItemText(
  loop: LoopState | undefined,
  plan: TaskPlan | undefined,
): string | undefined {
  const id = loop?.current?.itemId;
  if (!id || !plan) return undefined;
  return plan.items.find((item) => item.id === id)?.text;
}
