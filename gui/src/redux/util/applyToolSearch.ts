import type { ChatHistoryItem, Tool } from "core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { makeSearchToolsTool } from "core/tools/definitions/searchTools";
import {
  activatedFromResults,
  DEFAULT_TOOL_BUDGET_TOKENS,
  selectTools,
} from "core/tools/toolSearch";
import { coreToolAdapter } from "core/tools/toolSearchAdapter";

/** Text of every search_tools result in the conversation, oldest first. */
function searchResultTexts(history: ChatHistoryItem[]): string[] {
  const out: string[] = [];
  for (const item of history) {
    for (const state of item.toolCallStates ?? []) {
      if (state.toolCall.function.name === BuiltInToolNames.SearchTools) {
        for (const o of state.output ?? []) out.push(o.content);
      }
    }
  }
  return out;
}

/**
 * The request's tool list under `experimental.toolSearch`. With the setting
 * off (or unset) the list is returned as it came, the same array: nothing
 * about the request changes. With "auto" it goes through selectTools, which
 * leaves it equal to today's list until the MCP tools pass the budget.
 */
export function applyToolSearch(
  activeTools: Tool[],
  options: {
    setting: "off" | "auto" | undefined;
    mode: "chat" | "plan" | "agent";
    family?: string;
    history: ChatHistoryItem[];
    budgetTokens?: number;
  },
): Tool[] {
  if (options.setting !== "auto") return activeTools;
  const core = activeTools.filter(
    (t) =>
      t.group === BUILT_IN_GROUP_NAME &&
      t.function.name !== BuiltInToolNames.SearchTools,
  );
  const mcp = activeTools.filter((t) => t.group !== BUILT_IN_GROUP_NAME);
  const { tools, engaged } = selectTools({
    mode: options.mode,
    family: options.family,
    coreTools: core,
    mcpTools: mcp,
    budgetTokens: options.budgetTokens ?? DEFAULT_TOOL_BUDGET_TOKENS,
    metaTool: makeSearchToolsTool,
    adapter: coreToolAdapter,
    activatedNames: activatedFromResults(searchResultTexts(options.history)),
  });
  if (engaged) return tools;
  // Under the budget the list is today's, less the meta-tool config carries
  return activeTools.some(
    (t) => t.function.name === BuiltInToolNames.SearchTools,
  )
    ? activeTools.filter(
        (t) => t.function.name !== BuiltInToolNames.SearchTools,
      )
    : activeTools;
}
