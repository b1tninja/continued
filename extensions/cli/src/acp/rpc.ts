/**
 * A JSON-RPC 2.0 peer over newline-delimited JSON, the framing the Agent
 * Client Protocol uses on stdio: one message per line, no embedded newlines.
 * It is symmetric: the same object answers requests from the other side and
 * makes requests of its own (the agent asks the editor for permission).
 */

import { RpcError } from "./rpcError.js";

export { RpcError };

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const RPC_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type RequestHandler = (params: any) => Promise<unknown> | unknown;
export type NotificationHandler = (params: any) => void | Promise<void>;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private buffer = "";
  private closed = false;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();

  /**
   * @param write sends one already-framed line (ends with "\n")
   */
  constructor(private readonly write: (line: string) => void) {}

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Feed bytes read from the other side. Partial lines are held back. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) void this.dispatchLine(line);
    }
  }

  /** The other side went away: every request still waiting fails. */
  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      p.reject(new RpcError(RPC_CODES.internalError, "connection closed"));
    }
    this.pending.clear();
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new RpcError(RPC_CODES.internalError, "connection closed"),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: object): void {
    this.write(JSON.stringify(message) + "\n");
  }

  private async dispatchLine(line: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_CODES.parseError, message: "Parse error" },
      });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_CODES.invalidRequest, message: "Invalid request" },
      });
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message && message.id !== null) {
        await this.handleRequest(message.id, message.method, message.params);
      } else {
        try {
          await this.notificationHandlers.get(message.method)?.(message.params);
        } catch {
          // A notification has no reply to carry an error
        }
      }
      return;
    }
    if ("id" in message) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) {
        const e = message.error as JsonRpcError;
        waiting.reject(new RpcError(e.code, e.message, e.data));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  private async handleRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_CODES.methodNotFound,
          message: `Method not found: ${method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const error: JsonRpcError =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : {
              code: RPC_CODES.internalError,
              message: e instanceof Error ? e.message : String(e),
            };
      this.send({ jsonrpc: "2.0", id, error });
    }
  }
}
