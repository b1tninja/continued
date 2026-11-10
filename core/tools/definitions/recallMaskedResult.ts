import { Tool } from "../..";
import { RECALL_TOOL_NAME } from "../../util/contextAgeing";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const recallMaskedResultTool: Tool = {
  type: "function",
  displayTitle: "Recall Masked Result",
  wouldLikeTo: "read an earlier tool result again",
  isCurrently: "reading an earlier tool result",
  hasAlready: "read an earlier tool result",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.RecallMaskedResult,
    description: `Return the full text of an earlier tool result that was replaced by a placeholder to save space. A placeholder reads "[tool result masked: ... Call ${RECALL_TOOL_NAME} with handle mask-xxxxxxxx to read it again]". Use this only when you need the exact output again; running the original command again is the alternative.`,
    parameters: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: {
          type: "string",
          description:
            "The handle from the placeholder, for example mask-1a2b3c4d.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "ArrowUturnLeftIcon",
};
