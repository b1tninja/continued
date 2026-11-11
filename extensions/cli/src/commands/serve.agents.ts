import { agentRegistry } from "core/agents/registry.js";
import { projectAgents, type AgentsSnapshot } from "core/agents/project.js";
import type { Express, Request, Response } from "express";

import { emitAgent, ensureMainAgent, sessionCostUsd } from "../agents/feed.js";

import type { ServerState } from "./serve.helpers.js";

/**
 * The agents of this session as `GET /agents` shows them. Built from the
 * agent map's allow-list only: never the session, the history, a pending
 * permission's arguments or the loop, which `GET /state` returns whole.
 * The main node's state is taken from two booleans here: whether a
 * permission is pending and whether a turn is running.
 */
export function getAgentsSnapshot(state: ServerState): AgentsSnapshot {
  try {
    const main = ensureMainAgent();
    emitAgent({
      type: "state",
      id: main,
      state: state.pendingPermission ? "waiting-approval" : "running",
    });
    emitAgent({
      type: "activity",
      id: main,
      activity: state.pendingPermission
        ? "waiting for you"
        : state.isProcessing
          ? "working"
          : "waiting for you",
    });
    return projectAgents(agentRegistry.list(), {
      sessionCostUsd: sessionCostUsd(),
    });
  } catch {
    return projectAgents([], {});
  }
}

/** GET /agents. The guards and the token are installed before this runs. */
export function registerAgentsRoute(app: Express, state: ServerState): void {
  app.get("/agents", (_req: Request, res: Response) => {
    state.lastActivity = Date.now();
    res.json(getAgentsSnapshot(state));
  });
}
