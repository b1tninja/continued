import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateServeToken,
  jsonErrorHandler,
  MAX_BODY_BYTES,
  readServeTokenFile,
  refuseUpgrades,
  resolveServeAuth,
  WindowCounter,
  writeServeTokenFile,
} from "./serve.auth.js";
import { installServeGuards, isLoopbackHost } from "./serve.helpers.js";
import { serveWarnings } from "./serve.startup.js";

const TOKEN = "0123456789abcdef0123";

const globalDir = vi.hoisted(() => ({ path: "" }));
vi.mock("core/util/paths.js", () => ({
  getGlobalDirPath: () => globalDir.path,
}));

function resolve(input: {
  host?: string;
  token?: string;
  noAuth?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveServeAuth({
    host: "127.0.0.1",
    env: {},
    loopback: isLoopbackHost,
    ...input,
  });
}

describe("resolveServeAuth", () => {
  it("generates a token when none is given, even on loopback", () => {
    const r = resolve({});
    if (!("auth" in r) || r.auth.mode !== "token") throw new Error("no token");
    expect(r.auth.source).toBe("generated");
    // 256 bits, base64url
    expect(Buffer.from(r.auth.token, "base64url")).toHaveLength(32);
    expect(generateServeToken()).not.toBe(generateServeToken());
  });

  it("takes --token before the environment, and requires 16 characters", () => {
    expect(resolve({ token: ` ${TOKEN} ` })).toEqual({
      auth: { mode: "token", token: TOKEN, source: "flag" },
    });
    expect(resolve({ env: { CONTINUOUS_SERVE_TOKEN: TOKEN } })).toEqual({
      auth: { mode: "token", token: TOKEN, source: "env" },
    });
    expect(resolve({ token: "short" })).toHaveProperty("problem");
  });

  it("allows --no-auth only on loopback and not beside a token", () => {
    expect(resolve({ noAuth: true })).toEqual({ auth: { mode: "none" } });
    expect(resolve({ noAuth: true, host: "0.0.0.0" })).toHaveProperty(
      "problem",
    );
    expect(resolve({ noAuth: true, token: TOKEN })).toHaveProperty("problem");
  });

  it("generates a token off loopback too, and warns loudly", () => {
    const r = resolve({ host: "0.0.0.0" });
    if (!("auth" in r)) throw new Error("refused");
    expect(r.auth.mode).toBe("token");
    expect(serveWarnings({ host: "0.0.0.0", auth: r.auth }).join(" ")).toMatch(
      /beyond this computer/,
    );
    expect(serveWarnings({ host: "127.0.0.1", auth: r.auth })).toEqual([]);
    expect(
      serveWarnings({ host: "127.0.0.1", auth: { mode: "none" } })[0],
    ).toMatch(/--no-auth/);
  });
});

describe("the token file", () => {
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is written owner-only and read back", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-token-"));
    globalDir.path = path.join(dir, "global");
    const target = path.join(globalDir.path, "serve-4242.token");
    // A loose file left by an earlier run must not keep its mode
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "old", { mode: 0o644 });
    const file = writeServeTokenFile(4242, TOKEN);
    expect(file).toBe(target);
    expect(readServeTokenFile(4242)).toBe(TOKEN);
    expect(readServeTokenFile(4243)).toBeUndefined();
    if (process.platform === "win32") {
      // Windows has no mode bits: the folder's inherited ACL is the protection
      return;
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("WindowCounter", () => {
  it("refuses past the limit and recovers after the window", () => {
    let now = 0;
    const c = new WindowCounter(2, 1000, () => now);
    expect([c.hit("a"), c.hit("a"), c.hit("a")]).toEqual([true, true, false]);
    expect(c.blocked("a")).toBe(true);
    expect(c.hit("b")).toBe(true);
    now = 1001;
    expect(c.blocked("a")).toBe(false);
    expect(c.hit("a")).toBe(true);
  });
});

describe("a running guarded server", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  async function start(
    options: { allowedOrigins?: string[]; token?: string | null } = {},
  ) {
    const token = options.token === null ? undefined : (options.token ?? TOKEN);
    let handler: express.Express = express();
    const server = http.createServer((req, res) => handler(req, res));
    refuseUpgrades(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // The port is only known after listen, so the guards are installed now
    const inner = express();
    installServeGuards(inner, {
      boundHost: "127.0.0.1",
      token,
      port,
      allowedOrigins: options.allowedOrigins,
    });
    inner.use(express.json({ limit: MAX_BODY_BYTES }));
    inner.get("/state", (_req, res) => res.json({ ok: true }));
    inner.post("/message", (req, res) => res.json({ got: req.body }));
    inner.use(jsonErrorHandler);
    handler = inner;
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return { port, server };
  }

  function call(
    port: number,
    headers: http.OutgoingHttpHeaders = {},
    opts: { method?: string; path?: string; body?: string } = {},
  ): Promise<{
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: opts.path ?? "/state",
          method: opts.method ?? "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  it("listens on loopback only", async () => {
    const { server } = await start();
    const address = server.address() as AddressInfo;
    expect(["127.0.0.1", "::1"]).toContain(address.address);
  });

  it("answers 401 to no token, a wrong token and a token in the query string", async () => {
    const { port } = await start();
    const host = `127.0.0.1:${port}`;
    expect((await call(port, { host })).status).toBe(401);
    expect(
      (await call(port, { host, authorization: "Bearer wrong-token-0123456" }))
        .status,
    ).toBe(401);
    for (const query of [`token=${TOKEN}`, `access_token=${TOKEN}`]) {
      const res = await call(port, { host }, { path: `/state?${query}` });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(TOKEN);
    }
    const ok = await call(port, { host, authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain(TOKEN);
  });

  it("answers 403 to a rebinding Host, with or without the token", async () => {
    const { port } = await start();
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      `127.0.0.1:${port + 1}`,
    ]) {
      const res = await call(port, {
        host,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(403);
    }
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const res = await call(port, {
        host,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(200);
    }
  });

  it("refuses a cross-origin request unless the origin is on the list, and never sends a wildcard", async () => {
    const { port } = await start({
      allowedOrigins: ["http://localhost:3000"],
    });
    const base = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
    };
    const evil = await call(port, { ...base, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const good = await call(port, { ...base, origin: "http://localhost:3000" });
    expect(good.status).toBe(200);
    expect(good.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );

    const preflight = await call(
      port,
      { host: base.host, origin: "http://localhost:3000" },
      { method: "OPTIONS" },
    );
    expect(preflight.status).toBe(204);
    const evilPreflight = await call(
      port,
      { host: base.host, origin: "https://evil.example" },
      { method: "OPTIONS" },
    );
    expect(evilPreflight.status).toBe(403);
  });

  it("refuses a cross-origin WebSocket upgrade", async () => {
    const { port } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/",
        headers: {
          host: `127.0.0.1:${port}`,
          origin: "https://evil.example",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          authorization: `Bearer ${TOKEN}`,
        },
      });
      req.on("upgrade", () => reject(new Error("upgrade was accepted")));
      req.on("response", (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("answers 413 to a body over the limit and 400 to bad JSON", async () => {
    const { port } = await start();
    const headers = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const big = JSON.stringify({ message: "x".repeat(1024 * 1024 + 10) });
    expect(
      (
        await call(port, headers, {
          method: "POST",
          path: "/message",
          body: big,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(port, headers, {
          method: "POST",
          path: "/message",
          body: "{nope",
        })
      ).status,
    ).toBe(400);
  });

  it("holds an address off after repeated failed attempts", async () => {
    const { port } = await start();
    const host = `127.0.0.1:${port}`;
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await call(port, { host })).status;
    expect(last).toBe(429);
    // Even the right token waits out the window
    expect(
      (await call(port, { host, authorization: `Bearer ${TOKEN}` })).status,
    ).toBe(429);
  });

  it("with --no-auth still checks Host and Origin", async () => {
    const { port } = await start({ token: null });
    expect((await call(port, { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await call(port, { host: "evil.example" })).status).toBe(403);
    expect(
      (
        await call(port, {
          host: `127.0.0.1:${port}`,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
  });
});

describe("a refused serve start", () => {
  it("prints one line on stderr and exits with status 2, without the token", async () => {
    const { prepareServeAccessOrExit, SERVE_REFUSED_EXIT_CODE } =
      await import("./serve.startup.js");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(() =>
        prepareServeAccessOrExit({ host: "0.0.0.0", token: "short" }, 8000),
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(SERVE_REFUSED_EXIT_CODE);
      expect(SERVE_REFUSED_EXIT_CODE).toBe(2);
      const text = String(err.mock.calls[0][0]);
      expect(text).toMatch(/^continuous serve: refused to start\. .*\n$/);
      expect(text.trim().split("\n")).toHaveLength(1);
      expect(text).toMatch(/CONTINUOUS_SERVE_TOKEN|--token/);
      expect(text).not.toContain("short");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});
