import { clipLabel, type AgentNodes } from "./reducer";
import {
  AGENT_ACTIVITIES,
  type AgentActivity,
  type AgentBudget,
  type AgentKind,
  type AgentNode,
  type AgentState,
  type AgentTokens,
  type AgentWorkspace,
  type BlockedOnKind,
  type UnknownOr,
} from "./types";

/**
 * What an endpoint or a view may show of the agents: an allow-list. Each
 * field is copied by name from a node, strings are clipped and the activity
 * must be one of the fixed words, so a field added to a node later does not
 * appear here until someone adds it on purpose.
 */
export interface AgentView {
  id: string;
  parentId?: string;
  rootId: string;
  kind: AgentKind;
  role: string;
  mode?: string;
  model?: string;
  state: AgentState;
  blockedOn?: BlockedOnKind;
  startedAt?: number;
  endedAt?: number;
  tokens?: AgentTokens;
  cost: { self: UnknownOr<number>; subtree: UnknownOr<number> };
  budget?: AgentBudget;
  workspace?: AgentWorkspace;
  activity?: AgentActivity;
  returnedLength?: number;
  needsYou: boolean;
}

export interface AgentsSnapshot {
  generatedAt: number;
  nodes: AgentView[];
  /** Ids of the agents that wait for the person, oldest first */
  needsYou: string[];
  totals: {
    running: number;
    waiting: number;
    done: number;
    failed: number;
    /** The session's cost, or "unknown" when any part of it is */
    costUsd: UnknownOr<number>;
  };
  /** Set when the projection could not be built; the list is then empty */
  error?: string;
}

export interface ProjectOptions {
  /**
   * What the session has spent in all, subagents and workers included (their
   * requests are in the session's total). The main node's own cost is this
   * minus what its descendants spent; without it that cost is unknown.
   */
  sessionCostUsd?: UnknownOr<number>;
  now?: number;
}

function sum(values: UnknownOr<number>[]): UnknownOr<number> {
  let total = 0;
  for (const v of values) {
    if (v === "unknown") return "unknown";
    total += v;
  }
  return total;
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

function selfCost(node: AgentNode): UnknownOr<number> {
  return finite(node.costUsd) && node.costUsd >= 0 ? node.costUsd : "unknown";
}

function orderedTree(nodes: AgentNode[]): AgentNode[] {
  const byParent = new Map<string | undefined, AgentNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    const key =
      node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), node]);
  }
  const out: AgentNode[] = [];
  const seen = new Set<string>();
  const visit = (node: AgentNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
    const kids = [...(byParent.get(node.id) ?? [])].sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
    );
    kids.forEach(visit);
  };
  const roots = [...(byParent.get(undefined) ?? [])].sort(
    (a, b) =>
      Number(b.kind === "main") - Number(a.kind === "main") ||
      (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  roots.forEach(visit);
  return out;
}

function subtreeCosts(
  ordered: AgentNode[],
  sessionCostUsd: UnknownOr<number> | undefined,
): Map<string, { self: UnknownOr<number>; subtree: UnknownOr<number> }> {
  const kids = new Map<string, AgentNode[]>();
  for (const n of ordered) {
    if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  }
  const memo = new Map<string, UnknownOr<number>>();
  const subtree = (n: AgentNode): UnknownOr<number> => {
    const known = memo.get(n.id);
    if (known !== undefined) return known;
    const value = sum([
      selfCost(n),
      ...(kids.get(n.id) ?? []).map((c) => subtree(c)),
    ]);
    memo.set(n.id, value);
    return value;
  };
  const out = new Map<
    string,
    { self: UnknownOr<number>; subtree: UnknownOr<number> }
  >();
  for (const n of ordered) {
    if (n.kind === "main") {
      // The session total already holds the children's spend: subtract it
      // so it is not counted twice. Unknown stays unknown, never zero.
      const below = sum((kids.get(n.id) ?? []).map((c) => subtree(c)));
      const total = sessionCostUsd ?? "unknown";
      const self =
        total === "unknown" || below === "unknown"
          ? "unknown"
          : Math.max(0, total - below);
      out.set(n.id, { self, subtree: total });
    } else {
      out.set(n.id, { self: selfCost(n), subtree: subtree(n) });
    }
  }
  return out;
}

function view(
  n: AgentNode,
  cost: { self: UnknownOr<number>; subtree: UnknownOr<number> },
): AgentView {
  const v: AgentView = {
    id: clipLabel(n.id) ?? "",
    rootId: clipLabel(n.rootId) ?? "",
    kind: n.kind,
    role: clipLabel(n.role) ?? n.kind,
    state: n.state,
    cost,
    needsYou:
      n.state === "waiting-approval" || n.blockedOn?.kind === "question",
  };
  if (n.parentId) v.parentId = clipLabel(n.parentId);
  const mode = clipLabel(n.mode);
  if (mode) v.mode = mode;
  const model = clipLabel(n.model);
  if (model) v.model = model;
  if (n.blockedOn) v.blockedOn = n.blockedOn.kind;
  if (finite(n.startedAt)) v.startedAt = n.startedAt;
  if (finite(n.endedAt)) v.endedAt = n.endedAt;
  if (n.tokens) {
    v.tokens = {
      input: n.tokens.input,
      output: n.tokens.output,
      cacheRead: n.tokens.cacheRead,
      cacheWrite: n.tokens.cacheWrite,
    };
  }
  if (n.budget) {
    v.budget = {
      ...(finite(n.budget.maxCostUsd)
        ? { maxCostUsd: n.budget.maxCostUsd }
        : {}),
      ...(finite(n.budget.maxTokens) ? { maxTokens: n.budget.maxTokens } : {}),
      ...(finite(n.budget.maxTurns) ? { maxTurns: n.budget.maxTurns } : {}),
    };
  }
  if (n.workspace) {
    const name = clipLabel(n.workspace.name);
    v.workspace = { kind: n.workspace.kind, ...(name ? { name } : {}) };
  }
  if (n.activity && AGENT_ACTIVITIES.includes(n.activity)) {
    v.activity = n.activity;
  }
  if (finite(n.returnedLength)) v.returnedLength = n.returnedLength;
  return v;
}

const EMPTY_TOTALS: AgentsSnapshot["totals"] = {
  running: 0,
  waiting: 0,
  done: 0,
  failed: 0,
  costUsd: "unknown",
};

/**
 * The allow-listed list for `GET /agents`, the CLI and the IDE tree. Fails
 * closed: if anything throws, the list is empty and the only text is a fixed
 * sentence, never the exception's message.
 */
export function projectAgents(
  nodes: AgentNodes | AgentNode[],
  options: ProjectOptions = {},
): AgentsSnapshot {
  const generatedAt = options.now ?? Date.now();
  try {
    const list = Array.isArray(nodes) ? nodes : [...nodes.values()];
    const ordered = orderedTree(list);
    const costs = subtreeCosts(ordered, options.sessionCostUsd);
    const views = ordered.map((n) =>
      view(n, costs.get(n.id) ?? { self: "unknown", subtree: "unknown" }),
    );
    const agents = views.filter((v) => v.kind !== "main");
    const main = views.find((v) => v.kind === "main");
    const waitingNodes = views
      .filter((v) => v.needsYou)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return {
      generatedAt,
      nodes: views,
      needsYou: waitingNodes.map((v) => v.id),
      totals: {
        running: agents.filter((v) => v.state === "running").length,
        waiting: agents.filter(
          (v) => v.state === "waiting-approval" || v.state === "blocked",
        ).length,
        done: agents.filter((v) => v.state === "done").length,
        failed: agents.filter(
          (v) =>
            v.state === "failed" ||
            v.state === "stopped" ||
            v.state === "over-budget",
        ).length,
        costUsd: main
          ? main.cost.subtree
          : sum(agents.filter((a) => !a.parentId).map((a) => a.cost.subtree)),
      },
    };
  } catch {
    return {
      generatedAt,
      nodes: [],
      needsYou: [],
      totals: EMPTY_TOTALS,
      error: "The agent list could not be built.",
    };
  }
}
