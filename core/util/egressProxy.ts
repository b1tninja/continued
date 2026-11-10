import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { lookup } from "node:dns/promises";
import { connect as netConnect, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  decideEgress,
  type EgressDecision,
  type EgressPolicy,
} from "./egressPolicy";

/**
 * The egress proxy of a jail (plans/jail-network.md, W6b): an HTTP proxy that
 * speaks CONNECT (HTTPS and anything else tunnelled) and plain HTTP forward,
 * and asks `decideEgress` about every connection. Nothing in the product
 * starts one yet.
 *
 * What it does for each request:
 * - decides first, on the name the client sent, with its own resolver;
 * - connects to the address the decision pinned and never resolves again, so a
 *   name that changes its answer between the check and the connection does not
 *   matter;
 * - answers a refusal with 403 and the decision's sentence, which names the
 *   jail, so the agent and the person know it was the jail;
 * - reports every decision to `onDecision`, allowed or not.
 *
 * What it does not do: read inside a tunnel (so domain fronting is not
 * caught), speak SOCKS, inject credentials (that is the model gateway), or
 * listen anywhere but where the caller says. Listen on loopback or a Unix
 * socket only. With a `token`, a client must send it in `Proxy-Authorization`
 * (Basic, any user name, or Bearer); that is what makes a TCP listener safe
 * from other processes on the machine.
 */
export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** All addresses of a name. Defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Addresses of this machine, refused as targets. Defaults to its interfaces. */
  ownAddresses?: readonly string[];
  /** For tests: how to open the connection to the pinned address */
  connect?: (address: string, port: number) => Socket;
  /** Called once per request, allowed or refused */
  onDecision?: (entry: EgressLogEntry) => void;
  /** Required in `Proxy-Authorization` when set */
  token?: string;
  /** Idle time before a tunnel or request is closed; 5 minutes by default */
  idleMs?: number;
}

export interface EgressLogEntry {
  time: string;
  /** `CONNECT` or the HTTP method */
  method: string;
  host: string;
  port: number;
  allow: boolean;
  /** The denial code, or `allowed` */
  code: string;
  /** The address connected to, when allowed and resolved */
  address?: string;
  /** What the client was told, for a refusal */
  message?: string;
}

export interface EgressProxy {
  server: Server;
  /** Listen on loopback (port 0 picks a free one) or on a Unix socket path */
  listen(where: { port?: number; host?: string; path?: string }): Promise<void>;
  /** The loopback port, once listening on one */
  port(): number | undefined;
  close(): Promise<void>;
}

export const systemResolver = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

export function ownInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((i) => i.address);
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  let presented: string | undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (bearer) presented = bearer[1].trim();
  else if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    presented = decoded.slice(decoded.indexOf(":") + 1);
  }
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `host:port` of a CONNECT target; the host may be a bracketed IPv6 address. */
function parseAuthority(
  text: string,
  defaultPort?: number,
): { host: string; port: number } | undefined {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (v6) {
    const port = v6[2] ? Number(v6[2]) : defaultPort;
    return port === undefined ? undefined : { host: v6[1], port };
  }
  const i = text.lastIndexOf(":");
  if (i < 0) {
    return defaultPort === undefined
      ? undefined
      : { host: text, port: defaultPort };
  }
  if (!/^\d+$/.test(text.slice(i + 1))) return undefined;
  return { host: text.slice(0, i), port: Number(text.slice(i + 1)) };
}

export function createEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const resolve = opts.resolve ?? systemResolver;
  const ownAddresses = opts.ownAddresses ?? ownInterfaceAddresses();
  const connect =
    opts.connect ?? ((address, port) => netConnect(port, address));
  const idleMs = opts.idleMs ?? 5 * 60_000;
  const sockets = new Set<Socket>();

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    // A peer that resets is not an error worth crashing on
    socket.on("error", () => {});
  };

  const log = (
    method: string,
    target: { host: string; port: number },
    d: EgressDecision,
  ) =>
    opts.onDecision?.({
      time: new Date().toISOString(),
      method,
      host: d.host,
      port: target.port,
      allow: d.allow,
      code: d.allow ? "allowed" : d.code,
      address: d.allow ? d.address : undefined,
      message: d.allow ? undefined : d.message,
    });

  const authorised = (req: IncomingMessage) =>
    !opts.token || tokenMatches(req.headers["proxy-authorization"], opts.token);

  const server = createServer();
  server.on("connection", track);

  // ---------------------------------------------------------- plain HTTP
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, text: string, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        connection: "close",
        ...headers,
      });
      res.end(`${text}\n`);
    };
    if (!authorised(req)) {
      return reply(407, "Proxy authentication required.", {
        "proxy-authenticate": 'Basic realm="egress"',
      });
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return reply(400, "This is a proxy. Send the full URL of the request.");
    }
    if (url.protocol !== "http:") {
      return reply(
        400,
        "Only http:// URLs are forwarded; use CONNECT for https.",
      );
    }
    const target = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 80,
    };
    void (async () => {
      const d = await decideEgress(opts.policy, target, {
        resolve,
        ownAddresses,
      });
      log(req.method ?? "GET", target, d);
      if (!d.allow) return reply(403, d.message);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
      }
      // The pinned address, never the name. A per-request agent, because
      // `createConnection` is ignored when `agent: false` supplies its own.
      const agent = new Agent();
      agent.createConnection = () => connect(d.address ?? d.host, target.port);
      const upstream = httpRequest({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent,
      });
      upstream.setTimeout(idleMs, () => upstream.destroy());
      upstream.on("response", (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        up.pipe(res);
      });
      upstream.on("error", (e) => {
        if (!res.headersSent)
          reply(502, `The connection failed (${e.message || e.name}).`);
        else res.destroy();
      });
      req.pipe(upstream);
    })();
  });

  // -------------------------------------------------------------- CONNECT
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refuse = (status: string, text: string, extra = "") => {
      client.end(
        `HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text) + 1}\r\n${extra}\r\n${text}\n`,
      );
    };
    if (!authorised(req)) {
      return refuse(
        "407 Proxy Authentication Required",
        "Proxy authentication required.",
        'proxy-authenticate: Basic realm="egress"\r\n',
      );
    }
    const target = parseAuthority(req.url ?? "");
    if (!target) return refuse("400 Bad Request", "CONNECT needs host:port.");
    void (async () => {
      const d = await decideEgress(opts.policy, target, {
        resolve,
        ownAddresses,
      });
      log("CONNECT", target, d);
      if (!d.allow) return refuse("403 Forbidden", d.message);
      const upstream = connect(d.address ?? d.host, target.port);
      track(upstream);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("error", (e) => {
        if (!client.destroyed) {
          refuse("502 Bad Gateway", `The connection failed (${e.message}).`);
        }
      });
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    })();
  });

  return {
    server,
    listen: (where) =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        const done = () => {
          server.off("error", reject);
          resolveListen();
        };
        if (where.path) server.listen(where.path, done);
        else server.listen(where.port ?? 0, where.host ?? "127.0.0.1", done);
      }),
    port: () => {
      const a = server.address();
      return a && typeof a === "object" ? a.port : undefined;
    },
    close: () =>
      new Promise((resolveClose) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolveClose());
      }),
  };
}
