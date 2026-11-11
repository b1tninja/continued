import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { AgentView } from "core/agents/project";
import type { AgentState } from "core/agents/types";
import { formatCostAmount } from "core/util/costOf";
import { useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectAgentsSnapshot } from "../../redux/selectors/selectAgents";

const STATE_LABEL: Record<AgentState, string> = {
  running: "Running",
  "waiting-approval": "Needs you",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  "over-budget": "Over budget",
};

const STATE_CLASS: Record<AgentState, string> = {
  running: "text-description",
  "waiting-approval": "text-warning",
  blocked: "text-warning",
  done: "text-success",
  failed: "text-error",
  stopped: "text-warning",
  "over-budget": "text-error",
};

const BLOCKED_LABEL: Record<string, string> = {
  approval: "waiting for you",
  question: "waiting for your answer",
  slot: "waiting for a free slot",
  dependency: "waiting for another item",
  budget: "out of budget",
};

const ACTIVE: ReadonlySet<AgentState> = new Set([
  "running",
  "waiting-approval",
  "blocked",
]);

/** Every agent started below `agent`, at any depth. */
function descendants(
  agent: AgentView,
  kids: Map<string, AgentView[]>,
): AgentView[] {
  return (kids.get(agent.id) ?? []).flatMap((k) => [
    k,
    ...descendants(k, kids),
  ]);
}

/**
 * The label a row shows. The session row is derived from what runs below it
 * (it is not "Running" once everything it started has ended), and an agent the
 * IDE restarted under is "Interrupted" rather than "Stopped".
 */
function stateOf(
  agent: AgentView,
  kids: Map<string, AgentView[]>,
): { label: string; className: string } {
  if (agent.interrupted && agent.state === "stopped") {
    return { label: "Interrupted", className: STATE_CLASS.stopped };
  }
  const below = agent.kind === "main" ? descendants(agent, kids) : [];
  if (agent.state === "running" && below.length > 0) {
    if (below.some((a) => a.state === "waiting-approval")) {
      return {
        label: STATE_LABEL["waiting-approval"],
        className: STATE_CLASS["waiting-approval"],
      };
    }
    if (!below.some((a) => ACTIVE.has(a.state))) {
      const allDone = below.every((a) => a.state === "done");
      return allDone
        ? { label: STATE_LABEL.done, className: STATE_CLASS.done }
        : { label: "Ended early", className: STATE_CLASS.stopped };
    }
  }
  return {
    label: STATE_LABEL[agent.state],
    className: STATE_CLASS[agent.state],
  };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function elapsed(agent: AgentView, now: number): string | undefined {
  if (agent.startedAt === undefined) return undefined;
  const s = Math.max(
    0,
    Math.round(((agent.endedAt ?? now) - agent.startedAt) / 1000),
  );
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function withChildren(agents: AgentView[]): Map<string, AgentView[]> {
  const kids = new Map<string, AgentView[]>();
  for (const a of agents) {
    if (!a.parentId) continue;
    kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
  }
  return kids;
}

interface RowProps {
  /** No agent's cost is known (the session's $0 would mislead): the list says so once instead of per row. */
  costUnknown: boolean;
  agent: AgentView;
  kids: Map<string, AgentView[]>;
  level: number;
  now: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}

function AgentRow({
  costUnknown,
  agent,
  kids,
  level,
  now,
  collapsed,
  toggle,
}: RowProps) {
  const children = kids.get(agent.id) ?? [];
  const open = !collapsed.has(agent.id);
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  const doing = agent.blockedOn
    ? BLOCKED_LABEL[agent.blockedOn]
    : agent.state === "running"
      ? agent.activity
      : undefined;
  const time = elapsed(agent, now);
  const tokens = agent.tokens
    ? agent.tokens.input + agent.tokens.output
    : undefined;
  const name = agent.kind === "main" ? "Session" : agent.role;
  const state = stateOf(agent, kids);
  return (
    <li data-testid={`agent-row-${agent.id}`} data-state={agent.state}>
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5"
        style={{ paddingLeft: `${level * 12}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="flex h-4 w-4 flex-shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-description hover:brightness-125"
            onClick={() => toggle(agent.id)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
            data-testid={`agent-toggle-${agent.id}`}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <span className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        )}
        <span
          className="max-w-full min-w-0 truncate font-semibold [overflow-wrap:anywhere]"
          title={name}
          data-testid={`agent-name-${agent.id}`}
        >
          {name}
        </span>
        <span
          className={`flex-shrink-0 rounded border border-solid border-border px-1 text-2xs ${state.className}`}
          data-testid={`agent-state-${agent.id}`}
        >
          {state.label}
        </span>
        {agent.model && (
          <span
            className="max-w-full min-w-0 truncate [overflow-wrap:anywhere] text-description-muted"
            title={agent.model}
          >
            {agent.model}
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-description-muted">
          {tokens !== undefined && tokens > 0 && (
            <span>{formatTokens(tokens)} tokens</span>
          )}
          {time && <span>{time}</span>}
          {!costUnknown && (
            <span
              data-testid={`agent-cost-${agent.id}`}
              title={
                children.length > 0
                  ? `Itself: ${formatCostAmount(agent.cost.self)}. With the agents below: ${formatCostAmount(agent.cost.subtree)}`
                  : undefined
              }
            >
              {formatCostAmount(agent.cost.subtree)}
            </span>
          )}
        </span>
      </div>
      {(doing || agent.workspace?.name) && (
        <div
          className="min-w-0 break-words text-description-muted"
          style={{ paddingLeft: `${level * 12 + 20}px` }}
          data-testid={`agent-doing-${agent.id}`}
        >
          {[doing, agent.workspace?.name].filter(Boolean).join(" · ")}
        </div>
      )}
      {children.length > 0 && open && (
        <ul
          className="m-0 list-none p-0"
          aria-label={`Agents started by ${name}`}
        >
          {children.map((child) => (
            <AgentRow
              key={child.id}
              costUnknown={costUnknown}
              agent={child}
              kids={kids}
              level={level + 1}
              now={now}
              collapsed={collapsed}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The agents of this session as a tree: the session, the subagents it
 * started and the workers of a Loop wave, each with a state chip, what it is
 * doing in a fixed phrase, its time, tokens and cost, and the cost of
 * everything below it. Read-only: Stop stays on the subagent's card and in
 * the loop inbox. Shows nothing until an agent has been started.
 */
export function AgentsList() {
  const snapshot = useAppSelector(selectAgentsSnapshot);
  const [listOpen, setListOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (snapshot.nodes.length === 0) return null;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const kids = withChildren(snapshot.nodes);
  const ids = new Set(snapshot.nodes.map((n) => n.id));
  const roots = snapshot.nodes.filter(
    (n) => !n.parentId || !ids.has(n.parentId),
  );
  const agentRows = snapshot.nodes.filter((n) => n.kind !== "main");
  const costUnknown =
    agentRows.length > 0 &&
    agentRows.every((n) => n.cost.subtree === "unknown");
  const waiting = snapshot.needsYou.length;
  const Icon = listOpen ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div data-testid="agents-panel" className="mx-1 mb-1 min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 border-none bg-transparent px-0.5 text-left text-2xs tracking-wide text-description-muted uppercase hover:brightness-125"
        onClick={() => setListOpen((o) => !o)}
        aria-expanded={listOpen}
        data-testid="agents-toggle"
      >
        <Icon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        Agents
        <span className="normal-case" data-testid="agents-summary">
          {snapshot.totals.running} running
          {waiting > 0 ? `, ${waiting} waiting for you` : ""}
          {snapshot.totals.done > 0 ? `, ${snapshot.totals.done} done` : ""}
          {snapshot.totals.failed > 0
            ? `, ${snapshot.totals.failed} ended early`
            : ""}
        </span>
        {!costUnknown && (
          <span className="ml-auto normal-case">
            {formatCostAmount(snapshot.totals.costUsd)}
          </span>
        )}
      </button>
      {listOpen && (
        <ul
          className="m-0 min-w-0 list-none rounded border border-solid border-border px-2 py-1 text-xs"
          aria-label="Agents"
          data-testid="agents-list"
        >
          {costUnknown && (
            <li
              className="py-0.5 text-description-muted"
              data-testid="agents-cost-unknown"
            >
              Cost: not known for this model
            </li>
          )}
          {roots.map((agent) => (
            <AgentRow
              key={agent.id}
              costUnknown={costUnknown}
              agent={agent}
              kids={kids}
              level={0}
              now={snapshot.generatedAt}
              collapsed={collapsed}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
