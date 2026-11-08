import {
  FINISH_ITEM_PARAMETERS,
  FINISH_ITEM_TOOL_DESCRIPTION,
  HOLD_QUESTION_PARAMETERS,
  holdQuestionToolDescription,
} from "core/tools/definitions/loopTools.js";
import {
  finishItemReport,
  finishItemResult,
  holdQuestion,
  holdQuestionResult,
} from "core/util/loopMode.js";

import {
  CLI_LOOP_TOOL_NAMES,
  commitLoop,
  getSessionLoop,
  requestLoopTurnEnd,
} from "../loop/loopSession.js";

import type { Tool, ToolParametersSchema } from "./types.js";

/**
 * Loop mode's two tools in the CLI, offered only while the loop runs an
 * item (getAllAvailableTools), with the IDE's descriptions and parameters
 * (core/tools/definitions/loopTools.ts). Design: plans/loop-mode.md.
 */

export const HOLD_QUESTION_TOOL_NAME = CLI_LOOP_TOOL_NAMES.holdQuestion;
export const FINISH_ITEM_TOOL_NAME = CLI_LOOP_TOOL_NAMES.finishItem;

/** Core's schema with a description on every property, as the CLI's type wants. */
function withDescriptions(
  schema: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  },
  descriptions: Record<string, string>,
): ToolParametersSchema {
  return {
    type: "object",
    required: schema.required,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        { ...value, description: value.description ?? descriptions[key] },
      ]),
    ) as ToolParametersSchema["properties"],
  };
}

function runningItem() {
  const loop = getSessionLoop();
  if (!loop || loop.current?.kind !== "item" || !loop.current.itemId) {
    throw new Error("This tool is only for an item that Loop mode is running.");
  }
  return { loop, itemId: loop.current.itemId };
}

export const holdQuestionTool: Tool = {
  name: HOLD_QUESTION_TOOL_NAME,
  displayName: "Hold Question",
  description: holdQuestionToolDescription(FINISH_ITEM_TOOL_NAME),
  readonly: true,
  isBuiltIn: true,
  parameters: withDescriptions(HOLD_QUESTION_PARAMETERS, {
    kind: '"assumption" (go on with your default) or "blocking"',
  }),
  run: async (args: Record<string, unknown>) => {
    const { loop, itemId } = runningItem();
    const result = holdQuestion(
      loop,
      {
        itemId,
        question: args?.question,
        kind: args?.kind,
        assumption: args?.assumption,
        toolNames: CLI_LOOP_TOOL_NAMES,
      },
      new Date(),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    commitLoop(result.loop);
    return holdQuestionResult(
      result.question,
      result.duplicate,
      CLI_LOOP_TOOL_NAMES,
    );
  },
};

export const finishItemTool: Tool = {
  name: FINISH_ITEM_TOOL_NAME,
  displayName: "Finish Item",
  description: FINISH_ITEM_TOOL_DESCRIPTION,
  readonly: true,
  isBuiltIn: true,
  parameters: withDescriptions(FINISH_ITEM_PARAMETERS, {
    outcome: "done, waiting or stuck",
  }),
  run: async (args: Record<string, unknown>) => {
    const { loop } = runningItem();
    const parsed = finishItemReport(args);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const { report } = parsed;
    commitLoop({
      ...loop,
      current: loop.current && { ...loop.current, report },
    });
    // The loop picks what comes next; no need to ask the model again
    requestLoopTurnEnd();
    return finishItemResult(report.outcome);
  },
};
