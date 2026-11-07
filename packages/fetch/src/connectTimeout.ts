import type * as http from "node:http";
import type * as net from "node:net";

/** Seconds to wait for a TCP connection when `connectTimeout` is not set. */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Give an agent a connect timeout: a socket that has not connected within
 * `ms` is destroyed with an ETIMEDOUT error.
 *
 * Node's http and https agents have none of their own, so a server whose
 * packets are dropped (a host that is down, a firewall, a VPN that is not
 * up) makes a request wait out the operating system's TCP timeout, about
 * 21 s on Windows, and longer after each retry. A server that is reachable
 * connects in milliseconds, so a few seconds is enough. The `timeout` request
 * option (for the whole response) is unchanged.
 */
export function withConnectTimeout<T extends http.Agent>(
  agent: T,
  ms: number,
): T {
  const create = (
    agent as unknown as {
      createConnection?: (...args: unknown[]) => net.Socket | undefined;
    }
  ).createConnection;
  if (typeof create !== "function" || !(ms > 0)) return agent;
  (
    agent as unknown as {
      createConnection: (...args: unknown[]) => net.Socket | undefined;
    }
  ).createConnection = function (...args: unknown[]) {
    const socket = create.apply(this, args);
    if (!socket || socket.connecting === false) return socket;
    const options = (args[0] ?? {}) as { host?: string; port?: number };
    const timer = setTimeout(() => {
      const error = Object.assign(
        new Error(
          `connect ETIMEDOUT ${options.host ?? ""}:${options.port ?? ""} (no answer within ${ms / 1000} s)`,
        ),
        { code: "ETIMEDOUT", errno: "ETIMEDOUT", syscall: "connect" },
      );
      socket.destroy(error);
    }, ms);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    socket.once("connect", clear);
    socket.once("close", clear);
    return socket;
  };
  return agent;
}
