import { createSelector } from "@reduxjs/toolkit";
import { projectAgents, type AgentsSnapshot } from "core/agents/project";
import {
  loopWorkerToNode,
  mainAgentId,
  subagentRunToNode,
} from "core/agents/fromRuns";
import type { AgentNode } from "core/agents/types";
import { costMarkOf, costSince } from "core/util/loopCost";
import type { RootState } from "../store";

const MAIN_ROLE = "session";

/**
 * The agent map for this window, built from what the session already keeps:
 * the run on each subagent tool call and the loop's parallel workers. Only
 * names, states and numbers are read (core/agents/fromRuns.ts), so the
 * prompt, the answer and the tool-call summaries of a run never reach the
 * tree. Nothing is stored: it is recomputed when the history changes.
 */
export const selectAgentNodes = createSelector(
  [
    (s: RootState) => s.session.id,
    (s: RootState) => s.session.history,
    (s: RootState) => s.session.loop,
  ],
  (sessionId, history, loop): AgentNode[] => {
    const rootId = mainAgentId(sessionId);
    const nodes: AgentNode[] = [];
    for (const item of history) {
      for (const call of item.toolCallStates ?? []) {
        if (!call.subagent) continue;
        nodes.push(
          subagentRunToNode(call.subagent, {
            toolCallId: call.toolCallId,
            rootId,
            parentId: rootId,
          }),
        );
      }
    }
    for (const run of loop?.parallel ?? []) {
      const model = loop?.items.find((i) => i.id === run.itemId)?.model?.title;
      nodes.push(loopWorkerToNode(run, { rootId, parentId: rootId, model }));
    }
    if (nodes.length === 0) return [];
    return [
      {
        id: rootId,
        rootId,
        kind: "main",
        role: MAIN_ROLE,
        state: "running",
      },
      ...nodes,
    ];
  },
);

/** The nodes projected through the allow-list, with the session's cost. */
export const selectAgentsSnapshot = createSelector(
  [selectAgentNodes, (s: RootState) => s.session.usage],
  (nodes, usage): AgentsSnapshot =>
    projectAgents(nodes, {
      // The session total holds the subagents' spend, so the main node's own
      // share is what is left; a model without a price makes it unknown.
      sessionCostUsd: costSince({}, costMarkOf(usage)).amount,
    }),
);
