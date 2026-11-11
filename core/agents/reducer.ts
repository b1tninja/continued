import { activityForTool } from "./activity";
import {
  isAgentStateTerminal,
  type AgentBudget,
  type AgentEvent,
  type AgentNode,
  type AgentWorkspace,
} from "./types";

export type AgentNodes = ReadonlyMap<string, AgentNode>;

/** Where free-text fields stop: a label, not a message. */
export const AGENT_LABEL_MAX = 60;

export function clipLabel(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > AGENT_LABEL_MAX
    ? `${oneLine.slice(0, AGENT_LABEL_MAX - 1)}…`
    : oneLine;
}

const count = (n: number | undefined): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;

function cleanBudget(b: AgentBudget): AgentBudget {
  const out: AgentBudget = {};
  if (typeof b.maxCostUsd === "number" && b.maxCostUsd >= 0) {
    out.maxCostUsd = b.maxCostUsd;
  }
  const tokens = count(b.maxTokens);
  if (tokens !== undefined) out.maxTokens = tokens;
  const turns = count(b.maxTurns);
  if (turns !== undefined) out.maxTurns = turns;
  return out;
}

function cleanWorkspace(w: AgentWorkspace): AgentWorkspace {
  const name = clipLabel(w.name);
  return { kind: w.kind, ...(name ? { name } : {}) };
}

function spawn(event: Extract<AgentEvent, { type: "spawned" }>): AgentNode {
  const mode = clipLabel(event.mode);
  const model = clipLabel(event.model);
  return {
    id: event.id,
    ...(event.parentId ? { parentId: event.parentId } : {}),
    rootId: event.rootId,
    kind: event.kind,
    role: clipLabel(event.role) ?? event.kind,
    state: event.state ?? "running",
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(event.blockedOn ? { blockedOn: { kind: event.blockedOn } } : {}),
    ...(event.workspace ? { workspace: cleanWorkspace(event.workspace) } : {}),
    ...(event.budget ? { budget: cleanBudget(event.budget) } : {}),
    ...(event.at === undefined ? {} : { startedAt: event.at }),
  };
}

function setState(
  node: AgentNode,
  event: Extract<AgentEvent, { type: "state" }>,
): AgentNode {
  const next: AgentNode = { ...node, state: event.state };
  delete next.blockedOn;
  if (event.blockedOn) next.blockedOn = { kind: event.blockedOn };
  if (event.state === "waiting-approval") {
    next.blockedOn = { kind: "approval" };
    next.activity = "waiting for you";
  }
  if (isAgentStateTerminal(event.state) && event.at !== undefined) {
    next.endedAt = event.at;
  }
  return next;
}

function setUsage(
  node: AgentNode,
  event: Extract<AgentEvent, { type: "usage" }>,
): AgentNode {
  const t = event.tokens;
  return {
    ...node,
    tokens: {
      input: count(t.input) ?? 0,
      output: count(t.output) ?? 0,
      cacheRead: count(t.cacheRead) ?? 0,
      cacheWrite: count(t.cacheWrite) ?? 0,
    },
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
  };
}

function end(
  node: AgentNode,
  event: Extract<AgentEvent, { type: "ended" }>,
): AgentNode {
  const next: AgentNode = { ...node, state: event.state };
  delete next.blockedOn;
  delete next.activity;
  if (event.at !== undefined) next.endedAt = event.at;
  const length = count(event.returnedLength);
  if (length !== undefined) next.returnedLength = length;
  return next;
}

/**
 * One event applied to the nodes, without changing the input. The rules keep
 * a replay and a late or repeated event harmless: a second `spawned` for an
 * id is ignored, an event for an unknown id is ignored, and a node that has
 * ended stays as it ended.
 */
export function reduceAgents(nodes: AgentNodes, event: AgentEvent): AgentNodes {
  if (event.type === "spawned") {
    if (nodes.has(event.id)) return nodes;
    return new Map(nodes).set(event.id, spawn(event));
  }
  const node = nodes.get(event.id);
  if (!node || isAgentStateTerminal(node.state)) return nodes;
  let next: AgentNode;
  switch (event.type) {
    case "state":
      next = setState(node, event);
      break;
    case "activity":
      next = {
        ...node,
        activity: event.activity ?? activityForTool(event.tool),
      };
      break;
    case "usage":
      next = setUsage(node, event);
      break;
    case "budget":
      next = { ...node, budget: cleanBudget(event.budget) };
      break;
    case "ended":
      next = end(node, event);
      break;
  }
  return new Map(nodes).set(event.id, next);
}
