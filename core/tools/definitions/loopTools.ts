import { Tool } from "../..";
import { LOOP_LIMITS } from "../../util/loopMode";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

/**
 * Loop mode's two tools, offered only while the loop runs an item
 * (selectActiveTools). Both run in the gui, which holds the loop's state.
 * Design: plans/loop-mode.md.
 */

/** hold_question's description; `finishItem` is the name the reader knows finish_item by. */
export function holdQuestionToolDescription(finishItem: string): string {
  return `Put a question in the person's inbox without stopping. They answer while work goes on; the answer comes back to you or to a later run of the item.

- kind "assumption" (the default choice): you go on with the default you state in \`assumption\`. If the person overrules it, the item is redone.
- kind "blocking": only when there is no reasonable default. Do what you can without the answer, then call ${finishItem} with outcome "waiting".

Make the question answerable on its own, without this conversation: say what it is about, the options, and your default.`;
}

export const HOLD_QUESTION_PARAMETERS = {
  type: "object" as const,
  required: ["question", "kind"],
  properties: {
    question: {
      type: "string",
      description: `The question, self-contained, at most ${LOOP_LIMITS.maxQuestionLength} characters`,
    },
    kind: {
      type: "string",
      enum: ["assumption", "blocking"],
    },
    assumption: {
      type: "string",
      description:
        'The default you are continuing with. Required for kind "assumption".',
    },
  },
};

export const FINISH_ITEM_TOOL_DESCRIPTION =
  'Report the item you were given and end your turn. outcome "done" when it is finished; "waiting" when it needs an answer to a blocking question; "stuck" when you cannot finish it (say why in summary).';

export const FINISH_ITEM_PARAMETERS = {
  type: "object" as const,
  required: ["outcome", "summary"],
  properties: {
    outcome: {
      type: "string",
      enum: ["done", "waiting", "stuck"],
    },
    summary: {
      type: "string",
      description: `One line: what you did, or why it is not done. At most ${LOOP_LIMITS.maxSummaryLength} characters.`,
    },
    notes: {
      type: "string",
      description: `Optional. What a later item should know: a command that works, a trap you hit. One or two lines, at most ${LOOP_LIMITS.maxNoteLength} characters; not progress.`,
    },
  },
};

export const holdQuestionTool: Tool = {
  type: "function",
  displayTitle: "Hold Question",
  wouldLikeTo: "ask the person a question",
  isCurrently: "asking the person a question",
  hasAlready: "asked the person a question",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.HoldQuestion,
    description: holdQuestionToolDescription(BuiltInToolNames.FinishItem),
    parameters: HOLD_QUESTION_PARAMETERS,
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "QuestionMarkCircleIcon",
};

export const finishItemTool: Tool = {
  type: "function",
  displayTitle: "Finish Item",
  wouldLikeTo: "report the item",
  isCurrently: "reporting the item",
  hasAlready: "reported the item",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.FinishItem,
    description: FINISH_ITEM_TOOL_DESCRIPTION,
    parameters: FINISH_ITEM_PARAMETERS,
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "CheckCircleIcon",
};
