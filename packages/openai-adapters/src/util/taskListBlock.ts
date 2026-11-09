/**
 * First line of the agent's task list block, which clients send as the last
 * user text of a request. Must equal TASK_LIST_BLOCK_OPEN in
 * core/util/taskPlan.ts (core/util/taskPlan.vitest.ts checks it).
 *
 * The block changes between requests whenever the agent ticks an item, so a
 * prompt cache point must go before it, never on it: the Bedrock and Anthropic
 * adapters both skip it when they place their last marker.
 */
export const TASK_LIST_BLOCK_OPEN = "<task_list>";

export function isTaskListBlockText(text: string | undefined): boolean {
  return !!text && text.startsWith(TASK_LIST_BLOCK_OPEN);
}
