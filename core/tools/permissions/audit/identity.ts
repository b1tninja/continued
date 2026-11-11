import { mainAgentId } from "../../../agents/fromRuns";
import type { AuditAgent } from "./record";

/**
 * Who is calling, for the audit record. The ids are the agent map's
 * (`core/agents/fromRuns.ts`), so a row joins to a node; a test holds the two
 * in step.
 */
export const subagentAgentId = (toolCallId: string) => `sub-${toolCallId}`;
export const loopWorkerAgentId = (itemId: string) => `worker-${itemId}`;

export function mainAuditAgent(sessionId: string, mode?: string): AuditAgent {
  return {
    id: mainAgentId(sessionId),
    kind: "main",
    ...(mode ? { mode } : {}),
  };
}

/** A subagent run for the parent's `subagent` tool call; it runs in the parent's mode. */
export function subagentAuditAgent(
  sessionId: string,
  toolCallId: string,
  role: string,
  mode?: string,
): AuditAgent {
  return {
    id: subagentAgentId(toolCallId),
    kind: "subagent",
    role,
    ...(mode ? { mode } : {}),
    parentId: mainAgentId(sessionId),
  };
}

export function loopWorkerAuditAgent(
  sessionId: string,
  itemId: string,
): AuditAgent {
  return {
    id: loopWorkerAgentId(itemId),
    kind: "loop-worker",
    role: `item ${itemId}`,
    mode: "loop",
    parentId: mainAgentId(sessionId),
  };
}
