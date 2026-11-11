import path from "path";

import { maskArgsForDisplay } from "core/tools/permissions/displayMask.js";

import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";

import { JsonRpcPeer, RPC_CODES, RpcError } from "./rpc.js";

/** The ACP protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * What the protocol layer needs from the CLI. The real one (`backend.ts`)
 * runs the CLI's own turn loop; tests give a scripted one, so the protocol
 * is checked with no model and no services.
 */
export interface AcpBackend {
  /** Start the one conversation of this process, rooted at `cwd`. */
  newSession(cwd: string): Promise<string>;
  /**
   * Run one turn to its end. The callbacks are the CLI's `StreamCallbacks`,
   * the same ones `cn serve` fills; `onToolPermissionRequest` is set, which
   * is what lets the policy engine ask instead of refusing.
   */
  runTurn(
    sessionId: string,
    text: string,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void>;
  /** Answer a request the policy engine raised through the callback. */
  resolvePermission(requestId: string, approved: boolean): void;
}

export interface AcpAgentInfo {
  name: string;
  title: string;
  version: string;
}

type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

interface OpenCall {
  id: string;
  name: string;
}

const MAX_RESULT_CHARS = 50_000;

export function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/^(read|view|cat)/.test(n)) return "read";
  if (/(delete|remove)/.test(n)) return "delete";
  if (/^(edit|write|multiedit|multi_edit|apply|create|patch)/.test(n)) {
    return "edit";
  }
  if (/(bash|shell|terminal|exec|run_command)/.test(n)) return "execute";
  if (/(search|grep|glob|find|^ls$|^list)/.test(n)) return "search";
  if (/(fetch|web)/.test(n)) return "fetch";
  return "other";
}

function argPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["filepath", "file_path", "path", "filename"]) {
    const v = a[key];
    if (typeof v === "string" && path.isAbsolute(v)) return v;
  }
  return undefined;
}

function titleFor(name: string, rawArgs: unknown): string {
  // The editor shows this title in its approval prompt
  const args = maskArgsForDisplay(rawArgs);
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const detail = a.command ?? a.filepath ?? a.file_path ?? a.path ?? a.query;
    if (typeof detail === "string" && detail) {
      const one = detail.split("\n")[0].slice(0, 120);
      return `${name}: ${one}`;
    }
  }
  return name;
}

/**
 * The Agent side of ACP over one JSON-RPC peer: initialize, session/new,
 * session/prompt, session/cancel, and session/update notifications for the
 * model's text and its tool calls. A tool call the policy engine would ask
 * about becomes `session/request_permission`.
 *
 * Fail closed: the answer to a permission request is an allow only when the
 * client selected exactly the allow option we offered. A cancelled outcome, an
 * error, a malformed reply, an unknown option, a lost connection and a
 * cancelled turn are all a refusal. Content this agent did not say it can
 * take (images, audio, embedded resources) is refused as invalid params
 * rather than dropped.
 */
export class AcpAgent {
  private initialized = false;
  private sessionId: string | undefined;
  private turn: { abort: AbortController } | undefined;
  private readonly pendingPermissions = new Set<string>();
  private toolSeq = 0;

  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly backend: AcpBackend,
    private readonly info: AcpAgentInfo,
  ) {
    peer.onRequest("initialize", (p) => this.initialize(p));
    peer.onRequest("authenticate", () => {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "No authentication method is offered; the CLI uses its own configuration.",
      );
    });
    peer.onRequest("session/new", (p) => this.newSession(p));
    peer.onRequest("session/prompt", (p) => this.prompt(p));
    peer.onNotification("session/cancel", (p) => this.cancel(p));
  }

  /** The connection ended: stop the running turn and refuse what waits. */
  shutdown(): void {
    this.turn?.abort.abort();
    this.refuseAllPending();
  }

  private initialize(params: any) {
    if (!params || !Number.isInteger(params.protocolVersion)) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "protocolVersion must be an integer",
      );
    }
    this.initialized = true;
    return {
      // The client's version if we speak it, else our latest; the client
      // closes the connection when it cannot use ours.
      protocolVersion:
        params.protocolVersion >= 1 &&
        params.protocolVersion <= ACP_PROTOCOL_VERSION
          ? params.protocolVersion
          : ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: this.info,
      authMethods: [],
    };
  }

  private requireInitialized() {
    if (!this.initialized) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "initialize must be the first request",
      );
    }
  }

  private async newSession(params: any) {
    this.requireInitialized();
    if (!params || typeof params.cwd !== "string") {
      throw new RpcError(RPC_CODES.invalidParams, "cwd is required");
    }
    if (!path.isAbsolute(params.cwd)) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "cwd must be an absolute path",
      );
    }
    if (this.sessionId) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "This process holds one session; start another process for another conversation.",
      );
    }
    // params.mcpServers is not used: the CLI loads the MCP servers of its own
    // configuration, and mcpCapabilities says no http or sse from the client.
    this.sessionId = await this.backend.newSession(params.cwd);
    return { sessionId: this.sessionId };
  }

  private promptText(blocks: unknown): string {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "prompt must be a non-empty array",
      );
    }
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (
        block?.type === "resource_link" &&
        typeof block.uri === "string"
      ) {
        parts.push(`@${block.uri}`);
      } else {
        throw new RpcError(
          RPC_CODES.invalidParams,
          `Unsupported prompt content: ${String(block?.type)}. Only text and resource_link are accepted.`,
        );
      }
    }
    return parts.join("\n\n");
  }

  private async prompt(params: any) {
    this.requireInitialized();
    if (!params || !this.sessionId || params.sessionId !== this.sessionId) {
      throw new RpcError(RPC_CODES.invalidParams, "Unknown sessionId");
    }
    if (this.turn) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "A prompt turn is already running in this session",
      );
    }
    const text = this.promptText(params.prompt);
    const sessionId = this.sessionId;
    const abort = new AbortController();
    this.turn = { abort };
    try {
      await this.backend.runTurn(
        sessionId,
        text,
        this.callbacks(sessionId, abort.signal),
        abort.signal,
      );
      return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
    } catch (e) {
      // The protocol asks for cancelled, not an error, when a cancel
      // interrupted the turn.
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw e;
    } finally {
      this.turn = undefined;
      this.refuseAllPending();
    }
  }

  private cancel(params: any) {
    if (params?.sessionId !== this.sessionId) return;
    this.turn?.abort.abort();
    this.refuseAllPending();
  }

  private refuseAllPending() {
    for (const id of this.pendingPermissions) {
      this.backend.resolvePermission(id, false);
    }
    this.pendingPermissions.clear();
  }

  private update(sessionId: string, update: Record<string, unknown>) {
    this.peer.notify("session/update", { sessionId, update });
  }

  private callbacks(sessionId: string, signal: AbortSignal): StreamCallbacks {
    const open: OpenCall[] = [];
    const startCall = (name: string, args: unknown): OpenCall => {
      const call = { id: `call_${++this.toolSeq}`, name };
      open.push(call);
      const loc = argPath(args);
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: call.id,
        title: titleFor(name, args),
        kind: toolKindFor(name),
        status: "pending",
        rawInput: maskArgsForDisplay(args),
        ...(loc ? { locations: [{ path: loc }] } : {}),
      });
      return call;
    };
    const finish = (
      name: string,
      status: "completed" | "failed",
      text: string,
    ) => {
      const index = open.findIndex((c) => c.name === name);
      if (index < 0) return;
      const [call] = open.splice(index, 1);
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: call.id,
        status,
        content: [
          {
            type: "content",
            content: { type: "text", text: text.slice(0, MAX_RESULT_CHARS) },
          },
        ],
      });
    };

    return {
      onContent: (content) => {
        if (!content) return;
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: content },
        });
      },
      onToolStart: (name, args) => {
        startCall(name, args);
      },
      onToolResult: (result, name, status) => {
        finish(name, status === "done" ? "completed" : "failed", result);
      },
      onToolError: (error, name) => {
        if (name) finish(name, "failed", error);
      },
      onToolPermissionRequest: (name, args, requestId) => {
        const call = open.find((c) => c.name === name) ?? startCall(name, args);
        this.pendingPermissions.add(requestId);
        void this.askClient({ sessionId, call, name, args, requestId, signal });
      },
    };
  }

  private async askClient(ask: {
    sessionId: string;
    call: OpenCall;
    name: string;
    args: unknown;
    requestId: string;
    signal: AbortSignal;
  }) {
    const { sessionId, call, name, args, requestId, signal } = ask;
    let approved = false;
    try {
      if (!signal.aborted) {
        const reply = await this.peer.request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: call.id,
            title: titleFor(name, args),
            kind: toolKindFor(name),
            status: "pending",
            rawInput: maskArgsForDisplay(args),
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        approved =
          !signal.aborted &&
          reply?.outcome?.outcome === "selected" &&
          reply.outcome.optionId === "allow";
      }
    } catch {
      approved = false;
    }
    // A cancel or the end of the turn may have refused it already
    if (this.pendingPermissions.delete(requestId)) {
      this.backend.resolvePermission(requestId, approved);
    }
  }
}
