/**
 * The agent map (ROADMAP O11): one node per agent that runs in or beside a
 * session. Every field is a name, an enum, a number or a timestamp. There is
 * no field for a prompt, a tool argument, a command, a URL, a file's content
 * or the agent's own words, so nothing that carries a secret can be put in a
 * node or shown from one. `project.ts` copies fields by name and clips them.
 */

/** `external-reserved` has no producer yet; the shape is held for later. */
export type AgentKind =
  "main" | "subagent" | "loop-worker" | "background" | "external-reserved";

export type AgentState =
  | "running"
  | "waiting-approval"
  | "blocked"
  | "done"
  | "failed"
  | "stopped"
  | "over-budget";

export const TERMINAL_AGENT_STATES: readonly AgentState[] = [
  "done",
  "failed",
  "stopped",
  "over-budget",
];

export function isAgentStateTerminal(state: AgentState): boolean {
  return TERMINAL_AGENT_STATES.includes(state);
}

/** What a blocked or waiting agent waits on: a kind, never the detail. */
export type BlockedOnKind =
  "approval" | "question" | "slot" | "dependency" | "budget";

/** The only words an activity line can use. */
export const AGENT_ACTIVITIES = [
  "reading files",
  "searching",
  "editing",
  "running a command",
  "fetching",
  "working",
  "waiting for you",
] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export type UnknownOr<T> = T | "unknown";

export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxTurns?: number;
}

export interface AgentWorkspace {
  kind: "main" | "worktree";
  /** The worktree's folder name or the branch, never a full path */
  name?: string;
}

export interface AgentNode {
  /** Minted where the run starts; unique within a root */
  id: string;
  /** Undefined only for the main node */
  parentId?: string;
  /** The session's main node */
  rootId: string;
  kind: AgentKind;
  /** The definition's name ("explore") or "item 3"; clipped */
  role: string;
  /** The permission mode or loop, as a short word */
  mode?: string;
  /** The model's title */
  model?: string;
  state: AgentState;
  blockedOn?: { kind: BlockedOnKind };
  startedAt?: number;
  endedAt?: number;
  tokens?: AgentTokens;
  /** USD of this agent alone; unknown is never zero */
  costUsd?: UnknownOr<number>;
  budget?: AgentBudget;
  workspace?: AgentWorkspace;
  activity?: AgentActivity;
  /** How long what it handed back was; the text is not kept */
  returnedLength?: number;
  /** A stopped agent that the IDE restarted under, not one a person stopped */
  interrupted?: boolean;
}

/** What a producer says; the reducer decides what to keep. */
export type AgentEvent =
  | {
      type: "spawned";
      id: string;
      parentId?: string;
      rootId: string;
      kind: AgentKind;
      role: string;
      mode?: string;
      model?: string;
      state?: AgentState;
      blockedOn?: BlockedOnKind;
      workspace?: AgentWorkspace;
      budget?: AgentBudget;
      at?: number;
    }
  | {
      type: "state";
      id: string;
      state: AgentState;
      blockedOn?: BlockedOnKind;
      at?: number;
    }
  | { type: "activity"; id: string; tool?: string; activity?: AgentActivity }
  | {
      type: "usage";
      id: string;
      /** Cumulative for the run, so a replay sets the same value */
      tokens: AgentTokens;
      costUsd?: UnknownOr<number>;
    }
  | { type: "budget"; id: string; budget: AgentBudget }
  | {
      type: "ended";
      id: string;
      state: Extract<AgentState, "done" | "failed" | "stopped" | "over-budget">;
      returnedLength?: number;
      at?: number;
    };
