import { describe, expect, it } from "vitest";
import type { SubagentRunState } from "..";
import { activityForTool } from "./activity";
import { loopWorkerToNode, subagentRunToNode } from "./fromRuns";
import { projectAgents } from "./project";
import { AgentRegistry, AGENT_REGISTRY_MAX_NODES } from "./registry";
import { reduceAgents } from "./reducer";
import type { AgentEvent } from "./types";

const CANARY = "AKIAIOSFODNN7CANARY0 sk-canary-4f9a Bearer cnry.tok.123";

const main: AgentEvent = {
  type: "spawned",
  id: "main-s1",
  rootId: "main-s1",
  kind: "main",
  role: "session",
  at: 1,
};
const sub = (id: string, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({
    type: "spawned",
    id,
    parentId: "main-s1",
    rootId: "main-s1",
    kind: "subagent",
    role: "explore",
    at: 2,
    ...extra,
  }) as AgentEvent;

function run(events: AgentEvent[]) {
  const r = new AgentRegistry();
  events.forEach((e) => r.apply(e));
  return r;
}

describe("agent reducer", () => {
  it("spawns, works, waits for approval, and ends", () => {
    const r = run([
      main,
      sub("a", { state: "blocked", blockedOn: "slot" }),
      { type: "state", id: "a", state: "running" },
      { type: "activity", id: "a", tool: "Bash" },
      { type: "state", id: "a", state: "waiting-approval" },
    ]);
    const a = r.get("a")!;
    expect(a.state).toBe("waiting-approval");
    expect(a.blockedOn).toEqual({ kind: "approval" });
    expect(a.activity).toBe("waiting for you");
    r.apply({
      type: "ended",
      id: "a",
      state: "done",
      returnedLength: 42,
      at: 9,
    });
    expect(r.get("a")).toMatchObject({
      state: "done",
      returnedLength: 42,
      endedAt: 9,
    });
    expect(r.get("a")?.blockedOn).toBeUndefined();
    expect(r.get("a")?.activity).toBeUndefined();
  });

  it("ignores events for unknown ids, repeated spawns and anything after the end", () => {
    const r = run([
      { type: "state", id: "ghost", state: "running" },
      main,
      sub("a"),
      { type: "ended", id: "a", state: "failed" },
      { type: "state", id: "a", state: "running" },
      { type: "ended", id: "a", state: "done" },
      sub("a", { role: "other" }),
    ]);
    expect(r.get("ghost")).toBeUndefined();
    expect(r.get("a")).toMatchObject({ state: "failed", role: "explore" });
  });

  it("is idempotent when a stream is replayed", () => {
    const events: AgentEvent[] = [
      main,
      sub("a"),
      {
        type: "usage",
        id: "a",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      { type: "ended", id: "a", state: "done" },
    ];
    const once = run(events).list();
    const twice = run([...events, ...events]).list();
    expect(twice).toEqual(once);
  });

  it("does not change the map it was given", () => {
    const before = new Map();
    const after = reduceAgents(before, main);
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
  });

  it("clips labels and picks activity from a fixed vocabulary", () => {
    const r = run([main, sub("a", { role: `x${" y".repeat(100)}` })]);
    expect(r.get("a")!.role.length).toBeLessThanOrEqual(60);
    expect(activityForTool("mcp__vault__read_secret")).toBe("working");
    expect(activityForTool("Read")).toBe("reading files");
    expect(activityForTool("Edit")).toBe("editing");
    expect(activityForTool("Bash")).toBe("running a command");
  });

  it("keeps at most 500 nodes, dropping finished ones first", () => {
    const r = new AgentRegistry();
    r.apply(main);
    r.apply(sub("live"));
    for (let i = 0; i < AGENT_REGISTRY_MAX_NODES + 20; i++) {
      r.apply(sub(`x${i}`));
      r.apply({ type: "ended", id: `x${i}`, state: "done" });
    }
    const ids = r.list().map((n) => n.id);
    expect(ids.length).toBeLessThanOrEqual(AGENT_REGISTRY_MAX_NODES);
    expect(ids).toContain("main-s1");
    expect(ids).toContain("live");
  });
});

describe("projectAgents", () => {
  it("orders a tree, counts states, and lists who needs the person", () => {
    const r = run([
      main,
      sub("a"),
      sub("b", { at: 3 }),
      { type: "state", id: "b", state: "waiting-approval" },
      { type: "ended", id: "a", state: "done" },
    ]);
    const snap = projectAgents(r.list());
    expect(snap.nodes.map((n) => n.id)).toEqual(["main-s1", "a", "b"]);
    expect(snap.needsYou).toEqual(["b"]);
    expect(snap.totals).toMatchObject({ running: 0, waiting: 1, done: 1 });
  });

  it("subtracts children from the session total and never turns unknown into zero", () => {
    const events: AgentEvent[] = [
      main,
      sub("a"),
      sub("b"),
      { type: "usage", id: "a", tokens: tokens(), costUsd: 0.25 },
      { type: "usage", id: "b", tokens: tokens(), costUsd: 0.5 },
    ];
    const known = projectAgents(run(events).list(), { sessionCostUsd: 1 });
    const m = known.nodes[0].cost;
    expect(m.self).toBeCloseTo(0.25);
    expect(m.subtree).toBe(1);
    expect(known.nodes.find((n) => n.id === "a")?.cost).toEqual({
      self: 0.25,
      subtree: 0.25,
    });

    const noTotal = projectAgents(run(events).list());
    expect(noTotal.nodes[0].cost).toEqual({
      self: "unknown",
      subtree: "unknown",
    });

    const unpriced = projectAgents(
      run([...events.slice(0, 3), sub("c")].filter(Boolean)).list(),
      { sessionCostUsd: 1 },
    );
    expect(unpriced.nodes.find((n) => n.id === "c")?.cost.self).toBe("unknown");
    expect(unpriced.nodes[0].cost.self).toBe("unknown");
  });

  it("a node that is not in the tree still shows, as a root", () => {
    const snap = projectAgents([
      { ...run([main, sub("a")]).get("a")!, parentId: "missing" },
    ]);
    expect(snap.nodes).toHaveLength(1);
  });

  it("fails closed with a fixed sentence", () => {
    const bad = [
      {
        id: "x",
        get parentId(): string {
          throw new Error(CANARY);
        },
      },
    ];
    const snap = projectAgents(bad as never);
    expect(snap.nodes).toEqual([]);
    expect(snap.error).toBe("The agent list could not be built.");
    expect(JSON.stringify(snap)).not.toContain("CANARY");
  });

  it("copies only the allow-listed fields", () => {
    const polluted = {
      ...run([main, sub("a")]).get("a")!,
      prompt: CANARY,
      toolArgs: { command: CANARY },
      summary: CANARY,
      activity: CANARY,
    } as never;
    const text = JSON.stringify(projectAgents([polluted]));
    expect(text).not.toContain("sk-canary");
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("Bearer");
  });
});

const tokens = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });

describe("nodes from the IDE's runs", () => {
  const runState: SubagentRunState = {
    agent: "explore",
    model: "Haiku",
    description: CANARY,
    prompt: `find ${CANARY}`,
    status: "running",
    toolCalls: [{ name: "Bash", summary: `curl -H ${CANARY}`, status: "done" }],
    text: `answer ${CANARY}`,
    error: CANARY,
    notices: [CANARY],
    pendingApproval: {
      id: "p1",
      toolName: "run_terminal_command",
      summary: `rm ${CANARY}`,
      note: CANARY,
    },
    startedAt: 5,
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 7 },
  };

  it("maps status, usage and the wait for approval", () => {
    const node = subagentRunToNode(runState, {
      toolCallId: "tc1",
      rootId: "main-s1",
      parentId: "main-s1",
    });
    expect(node).toMatchObject({
      id: "sub-tc1",
      state: "waiting-approval",
      blockedOn: { kind: "approval" },
      tokens: { input: 100, output: 20, cacheRead: 7 },
    });
    const done = subagentRunToNode(
      { ...runState, status: "completed", pendingApproval: undefined },
      { toolCallId: "tc1", rootId: "r", parentId: "r" },
    );
    expect(done).toMatchObject({
      state: "done",
      returnedLength: runState.text.length,
    });
  });

  it("never lets prompt, tool summaries, text or approval text reach a view", () => {
    const nodes = [
      subagentRunToNode(runState, {
        toolCallId: "tc1",
        rootId: "main-s1",
        parentId: "main-s1",
      }),
      loopWorkerToNode(
        {
          itemId: "3",
          worktree: "C:\\Users\\someone\\repo-wt\\item-3",
          startedAt: "2026-11-10T10:00:00.000Z",
        },
        { rootId: "main-s1", parentId: "main-s1", model: "Local" },
      ),
    ];
    const text = JSON.stringify(projectAgents(nodes));
    expect(text).not.toContain("canary");
    expect(text).not.toContain("CANARY");
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("someone");
    expect(text).toContain("item-3");
  });
});
