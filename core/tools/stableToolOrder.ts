/**
 * Tool order for a request (C64). The tool list comes before the system
 * message and the conversation, so a reordered list makes a prompt cache read
 * the whole conversation again. MCP servers connect in no fixed order and a
 * reconnected server's tools move to the end, so the tools that come from
 * servers are sorted by name. Plain TypeScript with no node imports: the GUI
 * and the CLI share it.
 */

/** Code point order, never the locale's: the result must be the same everywhere. */
export function compareToolNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The tools with `isFixed` true keep their order and come first; the rest
 * follow, sorted by name. A copy: the input is not changed.
 */
export function stableToolOrder<T>(
  tools: readonly T[],
  nameOf: (tool: T) => string,
  isFixed: (tool: T) => boolean,
): T[] {
  return [
    ...tools.filter(isFixed),
    ...tools
      .filter((t) => !isFixed(t))
      .sort((a, b) => compareToolNames(nameOf(a), nameOf(b))),
  ];
}

/** True when CONTINUE_STABLE_TOOL_ORDER is not set to "0" or "false" (default on). */
export function stableToolOrderEnabled(value: string | undefined): boolean {
  return value !== "0" && value !== "false";
}
