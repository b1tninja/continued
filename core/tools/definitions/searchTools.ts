import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import { searchToolsDescription, ToolIndexEntry } from "../toolSearch";

/** The meta-tool, listing the tools a request leaves out (see toolSearch.ts). */
export function makeSearchToolsTool(
  deferred: readonly ToolIndexEntry[] = [],
): Tool {
  return {
    type: "function",
    displayTitle: "Search Tools",
    wouldLikeTo: "look for a tool",
    isCurrently: "looking for a tool",
    hasAlready: "looked for a tool",
    readonly: true,
    isInstant: true,
    group: BUILT_IN_GROUP_NAME,
    function: {
      name: BuiltInToolNames.SearchTools,
      description: searchToolsDescription(deferred),
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Keywords for what you need, for example 'github pull request'.",
          },
          limit: {
            type: "number",
            description: "Most tools to return. Default 5.",
          },
        },
      },
    },
    defaultToolPolicy: "allowedWithoutPermission",
    toolCallIcon: "MagnifyingGlassIcon",
  };
}

export const searchToolsTool: Tool = makeSearchToolsTool();
