import { agentRegistry } from "core/agents/registry.js";
import type { AgentEvent, AgentTokens, UnknownOr } from "core/agents/types.js";
import type { Usage } from "core/index.js";
import { costMarkOf, costSince } from "core/util/loopCost.js";

import { getCurrentSession, getSessionUsage } from "../session.js";
import { logger } from "../util/logger.js";

/**
 * Where the CLI tells the agent map what is starting and ending (ROADMAP
 * O11). Events carry names, states and numbers only. A failure here is
 * logged and dropped: the map is an observer and must not change a run.
 */

export function emitAgent(event: AgentEvent): void {
  try {
    agentRegistry.apply(event);
  } catch (error) {
    logger.debug("Agent map: event dropped", { error });
  }
}

/** The session's own node, made on first use; returns its id. */
export function ensureMainAgent(): string {
  let sessionId = "session";
  try {
    sessionId = getCurrentSession().sessionId;
  } catch {
    // no session yet: the node still has an id
  }
  const id = `main-${sessionId}`;
  emitAgent({
    type: "spawned",
    id,
    rootId: id,
    kind: "main",
    role: "session",
    at: Date.now(),
  });
  return id;
}

export function tokensOf(usage: Usage): AgentTokens {
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    cacheRead: usage.promptTokensDetails?.cachedTokens ?? 0,
    cacheWrite: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
  };
}

/** What the session has spent in all, or "unknown" when it cannot be priced. */
export function sessionCostUsd(): UnknownOr<number> {
  try {
    return costSince({}, costMarkOf(getSessionUsage())).amount;
  } catch {
    return "unknown";
  }
}
