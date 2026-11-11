import type { AddressInfo } from "node:net";

import { agentRegistry } from "core/agents/registry.js";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitAgent, ensureMainAgent } from "../agents/feed.js";

import { agentsCommand, formatAgents } from "./agents.js";
import { registerAgentsRoute } from "./serve.agents.js";
import { installServeGuards, type ServerState } from "./serve.helpers.js";

const TOKEN = "0123456789abcdef0123";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      env: {},
    },
  };
}

describe("continuous agents list", () => {
  const closers: Array<() => Promise<void>> = [];
  beforeEach(() => agentRegistry.reset());
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  async function serve(): Promise<string> {
    const app = express();
    installServeGuards(app, { boundHost: "127.0.0.1", token: TOKEN });
    registerAgentsRoute(app, {
      isProcessing: true,
      pendingPermission: null,
      lastActivity: 0,
    } as unknown as ServerState);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function twoAgents() {
    const main = ensureMainAgent();
    emitAgent({
      type: "spawned",
      id: "agent-1",
      parentId: main,
      rootId: main,
      kind: "subagent",
      role: "explore",
      model: "Haiku",
      at: Date.now(),
    });
    emitAgent({ type: "activity", id: "agent-1", tool: "Read" });
    return main;
  }

  it("prints a tree of the agents a running server reports", async () => {
    twoAgents();
    const url = await serve();
    const c = capture();
    expect(await agentsCommand("list", { url, token: TOKEN }, c.deps)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("AGENT");
    expect(text).toMatch(/session\s+main\s+running/);
    expect(text).toMatch(
      / {2}explore\s+subagent\s+running\s+Haiku\s+reading files/,
    );
  });

  it("prints the same projection as JSON with --json", async () => {
    twoAgents();
    const url = await serve();
    const c = capture();
    await agentsCommand(undefined, { url, token: TOKEN, json: true }, c.deps);
    const json = JSON.parse(c.out.join("\n"));
    expect(json.nodes.map((n: { kind: string }) => n.kind)).toEqual([
      "main",
      "subagent",
    ]);
    expect(Object.keys(json).sort()).toEqual([
      "generatedAt",
      "needsYou",
      "nodes",
      "totals",
    ]);
  });

  it("reads the token from the environment, and says what is wrong without one", async () => {
    const url = await serve();
    const withEnv = capture();
    withEnv.deps.env = { CONTINUOUS_SERVE_TOKEN: TOKEN };
    expect(await agentsCommand("list", { url }, withEnv.deps)).toBe(0);
    const without = capture();
    expect(await agentsCommand("list", { url }, without.deps)).toBe(1);
    expect(without.err.join("")).toContain("bearer token");
  });

  it("says so when no server answers, and rejects an unknown action", async () => {
    const c = capture();
    expect(
      await agentsCommand("list", { url: "http://127.0.0.1:1" }, c.deps),
    ).toBe(1);
    expect(c.err.join("")).toContain("Could not reach");
    const d = capture();
    expect(await agentsCommand("kill", {}, d.deps)).toBe(1);
  });

  it("strips control characters from what a server sent", () => {
    const lines = formatAgents({
      generatedAt: 1,
      needsYou: [],
      totals: { running: 1, waiting: 0, done: 0, failed: 0, costUsd: 0 },
      nodes: [
        {
          id: "a",
          rootId: "a",
          kind: "main",
          role: "ses\u001b[2Jsion",
          state: "running",
          cost: { self: "unknown", subtree: "unknown" },
          needsYou: false,
        },
      ],
    });

    expect(lines.join("\n")).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });
});
