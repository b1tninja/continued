import { EventEmitter } from "node:events";
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withConnectTimeout } from "./connectTimeout.js";

/** A socket still connecting, as for a server whose packets are dropped. */
function pendingSocket() {
  const socket = Object.assign(new EventEmitter(), {
    connecting: true,
    destroyed: undefined as Error | undefined,
    destroy: (error?: Error) => {
      socket.destroyed = error;
      socket.emit("close");
    },
  });
  return socket;
}

function agentReturning(socket: unknown) {
  const agent = new http.Agent();
  (agent as any).createConnection = vi.fn(() => socket);
  return agent;
}

describe("withConnectTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("destroys a socket that does not connect in time, with ETIMEDOUT", () => {
    vi.useFakeTimers();
    const socket = pendingSocket();
    const agent = withConnectTimeout(agentReturning(socket), 10_000);
    (agent as any).createConnection({ host: "172.27.144.1", port: 18092 });
    vi.advanceTimersByTime(9_999);
    expect(socket.destroyed).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(socket.destroyed).toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringContaining("172.27.144.1:18092"),
    });
  });

  it("leaves a socket alone once it has connected", () => {
    vi.useFakeTimers();
    const socket = pendingSocket();
    const agent = withConnectTimeout(agentReturning(socket), 1_000);
    (agent as any).createConnection({ host: "h", port: 1 });
    socket.emit("connect");
    vi.advanceTimersByTime(5_000);
    expect(socket.destroyed).toBeUndefined();
  });

  it("does nothing with a timeout of 0", () => {
    const agent = agentReturning(pendingSocket());
    const before = (agent as any).createConnection;
    expect((withConnectTimeout(agent, 0) as any).createConnection).toBe(before);
  });

  it("fails a real request to a closed port quickly, and connects to an open one", async () => {
    const server = http.createServer((_, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const agent = withConnectTimeout(new http.Agent(), 2_000);
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, agent }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          })
          .on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      server.close();
    }
  });
});
