import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "core/agents/registry.js";
import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { canarySecrets } from "core/util/secretScan/canary.js";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitAgent, ensureMainAgent } from "../agents/feed.js";

import { auditCommand } from "./audit.js";
import { registerAgentsRoute } from "./serve.agents.js";
import type { ServerState } from "./serve.helpers.js";
import { registerMessageRoutes } from "./serve.messages.js";

/** X10: the CLI half of the canary suite (core half: core/util/secretScan/canary.vitest.ts). */
const canary = canarySecrets();
const expectClean = (text: string) => {
  for (const c of canary.all) expect(text).not.toContain(c);
};

function state(): ServerState {
  return {
    session: {
      sessionId: "s1",
      title: "t",
      workspaceDirectory: "/w",
      history: [
        {
          message: { role: "user", content: `key ${canary.anthropicKey}` },
          contextItems: [],
        },
        {
          message: {
            role: "tool",
            content: `out ${canary.githubToken}`,
            toolCallId: "c1",
          },
          contextItems: [],
        },
      ],
    },
    config: {},
    model: {},
    isProcessing: false,
    lastActivity: 0,
    currentAbortController: null,
    serverRunning: true,
    pendingPermission: {
      toolName: "Bash",
      toolArgs: { command: `deploy ${canary.stripeKey}` },
      requestId: "r1",
      timestamp: 0,
      toolCallPreview: [{ arguments: { command: canary.npmToken } }],
    },
  } as unknown as ServerState;
}

async function serve(
  register: (app: express.Express) => void,
  route: string,
): Promise<string> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    return await res.text();
  } finally {
    server.close();
  }
}

describe("canaries on cn serve", () => {
  beforeEach(() => agentRegistry.reset());

  it("GET /state masks history and the pending approval's arguments", async () => {
    const s = state();
    const body = await serve(
      (app) =>
        registerMessageRoutes(app, {
          state: s,
          llmApi: {},
          syncSessionHistory: () => {},
          onIdle: async () => {},
        }),
      "/state",
    );
    expect(JSON.parse(body).pendingPermission.requestId).toBe("r1");
    expectClean(body);
    expect(body).toContain("masked:");
  });

  it("GET /agents shows no canary from the session or the approval", async () => {
    const s = state();
    const main = ensureMainAgent();
    emitAgent({
      type: "spawned",
      id: "a1",
      parentId: main,
      rootId: main,
      kind: "subagent",
      role: "explore",
      model: "m",
      task: `look at ${canary.awsAccessKey}`,
    } as never);
    const body = await serve((app) => registerAgentsRoute(app, s), "/agents");
    expectClean(body);
  });
});

describe("canaries in `continuous audit show`", () => {
  let dir: string;
  let stdout: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-canary-"));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      stdout.push(String(s));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is clean for a trail-written file and for a file something else wrote", () => {
    const trail = new AuditTrail({
      dir,
      enabled: true,
      now: () => new Date("2026-11-10T12:00:00Z"),
      syncImportant: false,
    });
    trail.decision({
      session: "s1",
      callId: "1",
      tool: "Bash",
      args: JSON.stringify({ command: `x ${canary.githubToken}` }),
      policy: "ask",
      by: "rules",
      reason: `about ${canary.stripeKey}`,
    });
    trail.outcome({ callId: "1", ran: true, output: canary.npmToken });
    // a record written by an older build, with the value in clear
    const file = fs.readdirSync(path.join(dir, "2026-11"))[0];
    fs.appendFileSync(
      path.join(dir, "2026-11", file),
      `${JSON.stringify({
        ev: "decision",
        v: 1,
        ts: "2026-11-10T12:00:01.000Z",
        session: "s1",
        callId: "2",
        tool: "Bash",
        argsMasked: `y ${canary.anthropicKey}`,
        policy: "ask",
        by: "rules",
      })}\n`,
    );
    auditCommand("show", "s1", { dir: dir });
    auditCommand("show", "s1", { dir: dir, json: true });
    expectClean(stdout.join(""));
  });
});
