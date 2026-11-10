import { toolPermissionManager } from "../permissions/permissionManager.js";
import { requestUserPermission } from "../stream/streamChatResponse.helpers.js";
import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import type { PreprocessedToolCall } from "../tools/types.js";

import { AcpAgent, type AcpBackend } from "./agent.js";
import { JsonRpcPeer } from "./rpc.js";

const NL = String.fromCharCode(10);

/** An in-memory editor: reads the agent's lines, answers its requests. */
class ScriptedClient {
  readonly updates: any[] = [];
  readonly permissionRequests: any[] = [];
  /** What the editor answers to session/request_permission */
  permissionReply: (params: any) => any = () => ({
    outcome: { outcome: "selected", optionId: "allow" },
  });
  private nextId = 1;
  private readonly waiting = new Map<number, (m: any) => void>();
  private agentBuffer = "";

  constructor(private readonly agentIn: (line: string) => void) {}

  /** Bytes the agent wrote */
  read(chunk: string) {
    this.agentBuffer += chunk;
    let i: number;
    while ((i = this.agentBuffer.indexOf(NL)) >= 0) {
      const msg = JSON.parse(this.agentBuffer.slice(0, i));
      this.agentBuffer = this.agentBuffer.slice(i + 1);
      this.onAgentMessage(msg);
    }
  }

  private onAgentMessage(msg: any) {
    if (msg.method === "session/update") {
      this.updates.push(msg.params.update);
    } else if (msg.method === "session/request_permission") {
      this.permissionRequests.push(msg.params);
      Promise.resolve()
        .then(() => this.permissionReply(msg.params))
        .then(
          (result) => ({ result }),
          (e: any) => ({ error: { code: -32603, message: String(e.message) } }),
        )
        .then((reply) =>
          this.agentIn(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }) + NL,
          ),
        );
    } else if ("id" in msg) {
      this.waiting.get(msg.id)?.(msg);
    }
  }

  call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.agentIn(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + NL);
    });
  }

  notify(method: string, params: unknown) {
    this.agentIn(JSON.stringify({ jsonrpc: "2.0", method, params }) + NL);
  }
}

function setup(backend: AcpBackend) {
  const client: ScriptedClient = new ScriptedClient((line) =>
    agentPeer.feed(line),
  );
  const agentPeer = new JsonRpcPeer((line) => client.read(line));
  new AcpAgent(agentPeer, backend, {
    name: "continuous",
    title: "Continuous",
    version: "0.0.0",
  });
  return client;
}

const resolved: Array<[string, boolean]> = [];

function scriptedBackend(
  run: (cb: StreamCallbacks, signal: AbortSignal) => Promise<void>,
): AcpBackend {
  return {
    newSession: async () => "s1",
    runTurn: (_id, _text, cb, signal) => run(cb, signal),
    resolvePermission: (id, approved) => {
      resolved.push([id, approved]);
      if (approved) toolPermissionManager.approveRequest(id);
      else toolPermissionManager.rejectRequest(id);
    },
  };
}

async function start(client: ScriptedClient) {
  await client.call("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const res = await client.call("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  return res.result.sessionId as string;
}

const fakeCall = (name: string, args: any) =>
  ({
    name,
    arguments: args,
    tool: undefined,
  }) as unknown as PreprocessedToolCall;

describe("ACP agent", () => {
  beforeEach(() => {
    resolved.length = 0;
  });

  it("initializes with the capabilities it supports and no auth", async () => {
    const client = setup(scriptedBackend(async () => {}));
    const res = await client.call("initialize", { protocolVersion: 1 });
    expect(res.result.protocolVersion).toBe(1);
    expect(res.result.agentCapabilities.loadSession).toBe(false);
    expect(res.result.agentCapabilities.promptCapabilities.image).toBe(false);
    expect(res.result.authMethods).toEqual([]);
    expect(res.result.agentInfo.name).toBe("continuous");
  });

  it("answers a newer client version with its own", async () => {
    const client = setup(scriptedBackend(async () => {}));
    const res = await client.call("initialize", { protocolVersion: 7 });
    expect(res.result.protocolVersion).toBe(1);
  });

  it("refuses session/new before initialize and a relative cwd", async () => {
    const client = setup(scriptedBackend(async () => {}));
    const early = await client.call("session/new", { cwd: process.cwd() });
    expect(early.error.code).toBe(-32600);
    await client.call("initialize", { protocolVersion: 1 });
    const rel = await client.call("session/new", { cwd: "relative/dir" });
    expect(rel.error.code).toBe(-32602);
  });

  it("allows one session per process", async () => {
    const client = setup(scriptedBackend(async () => {}));
    await start(client);
    const second = await client.call("session/new", { cwd: process.cwd() });
    expect(second.error.code).toBe(-32600);
  });

  it("streams message chunks and tool calls, then ends the turn", async () => {
    const client = setup(
      scriptedBackend(async (cb) => {
        cb.onContent?.("Looking");
        cb.onContent?.(" now");
        cb.onToolStart?.("Read", { filepath: "/repo/a.ts" });
        cb.onToolResult?.("file text", "Read", "done");
        cb.onToolStart?.("Bash", { command: "ls" });
        cb.onToolResult?.("boom", "Bash", "errored" as any);
      }),
    );
    const sessionId = await start(client);
    const res = await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(res.result).toEqual({ stopReason: "end_turn" });
    const kinds = client.updates.map((u) => u.sessionUpdate);
    expect(kinds).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
    ]);
    expect(client.updates[2]).toMatchObject({
      kind: "read",
      status: "pending",
      locations: [{ path: "/repo/a.ts" }],
    });
    expect(client.updates[3]).toMatchObject({
      toolCallId: client.updates[2].toolCallId,
      status: "completed",
    });
    expect(client.updates[4].kind).toBe("execute");
    expect(client.updates[5].status).toBe("failed");
  });

  it("refuses prompt content it did not advertise", async () => {
    const client = setup(scriptedBackend(async () => {}));
    const sessionId = await start(client);
    const res = await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "image", data: "x", mimeType: "image/png" }],
    });
    expect(res.error.code).toBe(-32602);
  });

  it("maps the policy engine's ask onto session/request_permission (allow)", async () => {
    let approved: boolean | undefined;
    const client = setup(
      scriptedBackend(async (cb) => {
        cb.onToolStart?.("Write", { filepath: "/repo/a.ts" });
        // The real path: the engine asks through requestUserPermission
        approved = await requestUserPermission(
          fakeCall("Write", { filepath: "/repo/a.ts" }),
          cb,
        );
      }),
    );
    const sessionId = await start(client);
    await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(approved).toBe(true);
    expect(client.permissionRequests).toHaveLength(1);
    const req = client.permissionRequests[0];
    expect(req.options.map((o: any) => o.kind)).toEqual([
      "allow_once",
      "reject_once",
    ]);
    expect(req.toolCall.toolCallId).toBe(client.updates[0].toolCallId);
  });

  it.each([
    [
      "reject selected",
      () => ({ outcome: { outcome: "selected", optionId: "reject" } }),
    ],
    ["cancelled", () => ({ outcome: { outcome: "cancelled" } })],
    [
      "unknown option",
      () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
    ],
    ["malformed reply", () => ({ nonsense: true })],
    ["empty reply", () => null],
    [
      "client error",
      () => {
        throw new Error("no");
      },
    ],
  ])("fails closed: %s is a refusal", async (_label, reply) => {
    let approved: boolean | undefined;
    const client = setup(
      scriptedBackend(async (cb) => {
        cb.onToolStart?.("Bash", { command: "rm -rf /" });
        approved = await requestUserPermission(
          fakeCall("Bash", { command: "rm -rf /" }),
          cb,
        );
      }),
    );
    client.permissionReply = reply;
    const sessionId = await start(client);
    await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(approved).toBe(false);
  });

  it("cancel refuses a pending permission and the turn ends as cancelled", async () => {
    let approved: boolean | undefined;
    const client = setup(
      scriptedBackend(async (cb, signal) => {
        cb.onToolStart?.("Bash", { command: "make" });
        approved = await requestUserPermission(
          fakeCall("Bash", { command: "make" }),
          cb,
        );
        expect(signal.aborted).toBe(true);
      }),
    );
    // The editor never answers
    client.permissionReply = () => new Promise(() => {}) as any;
    const sessionId = await start(client);
    const prompt = client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    await new Promise((r) => setTimeout(r, 20));
    client.notify("session/cancel", { sessionId });
    const res = await prompt;
    expect(res.result).toEqual({ stopReason: "cancelled" });
    expect(approved).toBe(false);
  });

  it("a backend with no permission callback would refuse: the agent always sets one", async () => {
    let hasCallback = false;
    const client = setup(
      scriptedBackend(async (cb) => {
        hasCallback = typeof cb.onToolPermissionRequest === "function";
      }),
    );
    const sessionId = await start(client);
    await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(hasCallback).toBe(true);
  });

  it("reports a backend failure as an error, not a stop reason", async () => {
    const client = setup(
      scriptedBackend(async () => {
        throw new Error("model unreachable");
      }),
    );
    const sessionId = await start(client);
    const res = await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(res.error.message).toBe("model unreachable");
  });
});
