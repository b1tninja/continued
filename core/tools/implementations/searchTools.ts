import { ToolImpl } from ".";
import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME } from "../builtIn";
import { makeSearchToolsTool } from "../definitions/searchTools";
import { getNumberArg, getStringArg } from "../parseArgs";
import {
  DEFAULT_TOOL_BUDGET_TOKENS,
  formatSearchResult,
  searchIndex,
  selectTools,
} from "../toolSearch";
import { coreToolAdapter } from "../toolSearchAdapter";

/**
 * Searches the MCP tools the request left out. It recomputes the split from
 * the config's tool list with the same policy the request used, so the index
 * is the deferred set; tools the person disabled in the GUI are not known
 * here and can appear in a result (the next request still leaves them out).
 */
export const searchToolsImpl: ToolImpl = async (args, extras) => {
  const query = getStringArg(args, "query");
  const limit = args.limit === undefined ? 5 : getNumberArg(args, "limit");
  const mcp: Tool[] = extras.config.tools.filter(
    (t) => t.group !== BUILT_IN_GROUP_NAME,
  );
  const { deferred } = selectTools({
    mode: "agent",
    family: extras.llm?.model,
    coreTools: [],
    mcpTools: mcp,
    budgetTokens: DEFAULT_TOOL_BUDGET_TOKENS,
    metaTool: makeSearchToolsTool,
    adapter: coreToolAdapter,
  });
  const matches = searchIndex(deferred, query, limit);
  return [
    {
      name: "Tool search",
      description: query,
      content: formatSearchResult(matches, query),
    },
  ];
};
