import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import {
  connect as netConnect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEgressPolicy } from "./egressPolicy";
import {
  createEgressProxy,
  type EgressLogEntry,
  type EgressProxy,
} from "./egressProxy";

// Everything here is on 127.0.0.1: a TCP echo server, an HTTP server, the
// proxy under test and a stub resolver. Nothing leaves the machine.

let tcp: TcpServer;
let web: HttpServer;
let tcpPort = 0;
let webPort = 0;
let proxy: EgressProxy | undefined;
let tcpConnections = 0;
let seen: { method?: string; url?: string; headers: Record<string, unknown> }[];

const listen = (server: TcpServer | HttpServer) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );

beforeEach(async () => {
  tcpConnections = 0;
  seen = [];
  tcp = createTcpServer((s) => {
    tcpConnections++;
    s.on("data", (d) => s.write(`echo:${d}`));
    s.on("error", () => {});
  });
  web = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "x-from": "web", connection: "close" });
    res.end(`hello ${req.method} ${req.url}`);
  });
  tcpPort = await listen(tcp);
  webPort = await listen(web);
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise((r) => tcp.close(r));
  await new Promise((r) => web.close(r));
});

async function start(
  settings: Parameters<typeof parseEgressPolicy>[0],
  extra: Partial<Parameters<typeof createEgressProxy>[0]> = {},
) {
  const log: EgressLogEntry[] = [];
  proxy = createEgressProxy({
    policy: parseEgressPolicy(settings).policy,
    resolve: async () => {
      throw new Error("no resolver in this test");
    },
    ownAddresses: [],
    onDecision: (e) => log.push(e),
    ...extra,
  });
  await proxy.listen({});
  return { log, port: proxy.port()! };
}

/** CONNECT through the proxy; resolves with the status line and the open socket. */
function connectThrough(
  proxyPort: number,
  target: string,
  headers: string[] = [],
): Promise<{ status: string; body: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1");
    let buf = "";
    socket.on("error", reject);
    socket.on("data", function onData(d) {
      buf += d.toString();
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const head = buf.slice(0, end);
      resolve({
        status: head.split("\r\n")[0],
        body: buf.slice(end + 4),
        socket,
      });
    });
    socket.write(
      [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        ...headers,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

const echoOnce = (socket: Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(text);
  });

/** A plain HTTP request to the proxy with an absolute URL. */
function viaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { host: new URL(url).host, ...headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("CONNECT", () => {
  it("tunnels to an address the list names, and logs the decision", async () => {
    const { log, port } = await start({
      network: "allowlist",
      allow: [`127.0.0.1:${tcpPort}`],
    });
    const { status, socket } = await connectThrough(
      port,
      `127.0.0.1:${tcpPort}`,
    );
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    expect(await echoOnce(socket, "ping")).toBe("echo:ping");
    socket.destroy();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      method: "CONNECT",
      host: "127.0.0.1",
      port: tcpPort,
      allow: true,
      code: "allowed",
      address: "127.0.0.1",
    });
  });

  it("refuses a host that is not listed, with the jail's sentence, and never connects", async () => {
    const { log, port } = await start({
      network: "allowlist",
      allow: ["registry.npmjs.org"],
    });
    const { status, body, socket } = await connectThrough(
      port,
      `127.0.0.1:${tcpPort}`,
    );
    expect(status).toBe("HTTP/1.1 403 Forbidden");
    expect(body).toContain("127.0.0.1");
    expect(body).toContain("allows hosts by name");
    socket.destroy();
    expect(tcpConnections).toBe(0);
    expect(log[0]).toMatchObject({ allow: false, code: "ip-literal" });
    expect(log[0].message).toBeDefined();
  });

  it("refuses everything in mode none", async () => {
    const { log, port } = await start({ network: "none" });
    const { status, socket } = await connectThrough(
      port,
      "registry.npmjs.org:443",
    );
    expect(status).toBe("HTTP/1.1 403 Forbidden");
    socket.destroy();
    expect(log[0].code).toBe("network-none");
  });

  it("connects to the pinned address and never to the name", async () => {
    const dialled: [string, number][] = [];
    const { log, port } = await start(
      { network: "allowlist", allow: ["registry.npmjs.org"] },
      {
        resolve: async () => ["104.16.1.34"],
        // The test's stand-in for the network: record the address, then reach the echo server
        connect: (address, p) => {
          dialled.push([address, p]);
          return netConnect(tcpPort, "127.0.0.1");
        },
      },
    );
    const { status, socket } = await connectThrough(
      port,
      "registry.npmjs.org:443",
    );
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    expect(await echoOnce(socket, "x")).toBe("echo:x");
    socket.destroy();
    expect(dialled).toEqual([["104.16.1.34", 443]]);
    expect(log[0]).toMatchObject({ allow: true, address: "104.16.1.34" });
  });

  it("refuses an allowed name that resolves to this machine, and one that rebinds", async () => {
    let calls = 0;
    const dialled: string[] = [];
    const { log, port } = await start(
      {
        network: "allowlist",
        allow: ["rebind.example.com", "local.example.com"],
      },
      {
        resolve: async (host) =>
          host === "local.example.com"
            ? ["127.0.0.1"]
            : ++calls === 1
              ? ["93.184.216.34"]
              : ["10.0.0.5"],
        connect: (address) => {
          dialled.push(address);
          return netConnect(tcpPort, "127.0.0.1");
        },
      },
    );
    const local = await connectThrough(port, "local.example.com:443");
    expect(local.status).toBe("HTTP/1.1 403 Forbidden");
    local.socket.destroy();
    const first = await connectThrough(port, "rebind.example.com:443");
    expect(first.status).toBe("HTTP/1.1 200 Connection Established");
    first.socket.destroy();
    const second = await connectThrough(port, "rebind.example.com:443");
    expect(second.status).toBe("HTTP/1.1 403 Forbidden");
    second.socket.destroy();
    expect(dialled).toEqual(["93.184.216.34"]);
    expect(log.map((e) => e.code)).toEqual([
      "address-denied",
      "allowed",
      "address-denied",
    ]);
  });

  it("answers 502 when the connection fails", async () => {
    const { port } = await start(
      { network: "allowlist", allow: ["registry.npmjs.org"] },
      {
        resolve: async () => ["93.184.216.34"],
        connect: () => netConnect(1, "127.0.0.1"),
      },
    );
    const { status, socket } = await connectThrough(
      port,
      "registry.npmjs.org:443",
    );
    expect(status).toBe("HTTP/1.1 502 Bad Gateway");
    socket.destroy();
  });

  it("rejects a CONNECT without a port", async () => {
    const { port } = await start({ network: "allowlist" });
    const { status, socket } = await connectThrough(port, "registry.npmjs.org");
    expect(status).toBe("HTTP/1.1 400 Bad Request");
    socket.destroy();
  });
});

describe("plain HTTP forward", () => {
  it("forwards to an allowed address, keeps the Host header, and drops proxy headers", async () => {
    const { log, port } = await start({
      network: "allowlist",
      allow: [`127.0.0.1:${webPort}`],
    });
    const r = await viaProxy(port, `http://127.0.0.1:${webPort}/a/b?c=1`, {
      "proxy-authorization": "Basic eDp5",
      "proxy-connection": "keep-alive",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello GET /a/b?c=1");
    expect(r.headers["x-from"]).toBe("web");
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["host"]).toBe(`127.0.0.1:${webPort}`);
    expect(seen[0].headers["proxy-authorization"]).toBeUndefined();
    expect(seen[0].headers["proxy-connection"]).toBeUndefined();
    expect(log[0]).toMatchObject({
      method: "GET",
      allow: true,
      code: "allowed",
    });
  });

  it("forwards by the pinned address for a listed name", async () => {
    const dialled: string[] = [];
    const { port } = await start(
      { network: "allowlist", allow: ["files.example.com:80"] },
      {
        resolve: async () => ["93.184.216.34"],
        connect: (address) => {
          dialled.push(address);
          return netConnect(webPort, "127.0.0.1");
        },
      },
    );
    const r = await viaProxy(port, "http://files.example.com/x");
    expect(r.status).toBe(200);
    expect(seen[0].headers["host"]).toBe("files.example.com");
    expect(dialled).toEqual(["93.184.216.34"]);
  });

  it("refuses a host that is not listed with 403 and never connects", async () => {
    const { log, port } = await start({
      network: "allowlist",
      allow: ["registry.npmjs.org"],
    });
    const r = await viaProxy(port, "http://files.example.com/x");
    expect(r.status).toBe(403);
    expect(r.body).toContain("not on the jail's network allowlist");
    expect(seen).toHaveLength(0);
    expect(log[0]).toMatchObject({ allow: false, code: "not-allowed" });
  });

  it("is a proxy, not a server: a request with a path alone gets 400", async () => {
    const { port } = await start({ network: "allowlist" });
    const r = await viaProxy(port, "/just/a/path").catch(() => undefined);
    // `new URL("/just/a/path")` throws in the helper, so ask directly
    expect(r).toBeUndefined();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/just/a/path", agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe("token", () => {
  it("answers 407 without it and accepts Basic or Bearer with it", async () => {
    const { port } = await start(
      {
        network: "allowlist",
        allow: [`127.0.0.1:${tcpPort}`, `127.0.0.1:${webPort}`],
      },
      { token: "s3cret" },
    );
    const none = await connectThrough(port, `127.0.0.1:${tcpPort}`);
    expect(none.status).toBe("HTTP/1.1 407 Proxy Authentication Required");
    none.socket.destroy();
    const wrong = await connectThrough(port, `127.0.0.1:${tcpPort}`, [
      "Proxy-Authorization: Bearer nope",
    ]);
    expect(wrong.status).toBe("HTTP/1.1 407 Proxy Authentication Required");
    wrong.socket.destroy();
    const basic = await connectThrough(port, `127.0.0.1:${tcpPort}`, [
      `Proxy-Authorization: Basic ${Buffer.from("jail:s3cret").toString("base64")}`,
    ]);
    expect(basic.status).toBe("HTTP/1.1 200 Connection Established");
    basic.socket.destroy();
    const bearer = await connectThrough(port, `127.0.0.1:${tcpPort}`, [
      "Proxy-Authorization: Bearer s3cret",
    ]);
    expect(bearer.status).toBe("HTTP/1.1 200 Connection Established");
    bearer.socket.destroy();

    expect((await viaProxy(port, `http://127.0.0.1:${webPort}/`)).status).toBe(
      407,
    );
    expect(
      (
        await viaProxy(port, `http://127.0.0.1:${webPort}/`, {
          "proxy-authorization": "Bearer s3cret",
        })
      ).status,
    ).toBe(200);
  });
});
