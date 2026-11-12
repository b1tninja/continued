import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import { getGlobalDirPath } from "core/util/paths.js";
import { ensurePrivateDir, writePrivate } from "core/util/privateFiles.js";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";

import { isLoopbackHost } from "./serve.helpers.js";

/**
 * Who may talk to `cn serve`, beyond the Host and Origin checks in
 * serve.helpers.ts. Without `--token` or CONTINUOUS_SERVE_TOKEN the server
 * makes its own: 256 random bits, written owner-only to the global folder and
 * shown once on the terminal. `--no-auth` turns the token off, on loopback
 * only.
 */

export const MIN_TOKEN_LENGTH = 16;

export type ServeAuth =
  | { mode: "none" }
  | { mode: "token"; token: string; source: "flag" | "env" | "generated" };

/** 256 random bits, URL-safe. */
export function generateServeToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Where the generated token for a port is kept. */
export function serveTokenFile(port: number | string): string {
  return path.join(getGlobalDirPath(), `serve-${port}.token`);
}

/** Write the token owner-only. A stale file is replaced, so its old mode never survives. */
export function writeServeTokenFile(
  port: number | string,
  token: string,
): string {
  const file = serveTokenFile(port);
  ensurePrivateDir(path.dirname(file));
  fs.rmSync(file, { force: true });
  writePrivate(file, `${token}\n`);
  return file;
}

/** The token a local `cn serve` on this port wrote, or undefined. */
export function readServeTokenFile(port: number | string): string | undefined {
  try {
    return fs.readFileSync(serveTokenFile(port), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The port in a server URL, or undefined. */
export function portOfUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return undefined;
  }
}

export interface ServeAuthInput {
  host: string;
  token?: string;
  noAuth?: boolean;
  env?: NodeJS.ProcessEnv;
  loopback: (host: string) => boolean;
}

/**
 * The access mode these options ask for, or an error text when the server
 * must not start with them.
 */
export function resolveServeAuth(
  input: ServeAuthInput,
): { auth: ServeAuth } | { problem: string } {
  const env = input.env ?? process.env;
  const flag = input.token?.trim();
  const fromEnv = env.CONTINUOUS_SERVE_TOKEN?.trim();
  const explicit = flag || fromEnv;
  if (input.noAuth) {
    if (!input.loopback(input.host)) {
      return {
        problem: `--no-auth is only allowed on loopback; --host ${input.host} listens beyond this computer. Drop --no-auth (a token is generated, or set --token / CONTINUOUS_SERVE_TOKEN), or use --host 127.0.0.1.`,
      };
    }
    if (explicit) {
      return {
        problem:
          "--no-auth cannot be combined with a token. Drop --no-auth, or unset --token and CONTINUOUS_SERVE_TOKEN.",
      };
    }
    return { auth: { mode: "none" } };
  }
  if (explicit) {
    if (explicit.length < MIN_TOKEN_LENGTH) {
      return {
        problem: `The serve token (${flag ? "--token" : "CONTINUOUS_SERVE_TOKEN"}) must be at least ${MIN_TOKEN_LENGTH} characters. Set a longer one, or leave it out to have one generated.`,
      };
    }
    return {
      auth: { mode: "token", token: explicit, source: flag ? "flag" : "env" },
    };
  }
  return {
    auth: { mode: "token", token: generateServeToken(), source: "generated" },
  };
}

/** A fixed-window counter per key. */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one event; false when the key is over its limit for the window. */
  hit(key: string): boolean {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 1000) this.hits.clear();
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Whether the key is already over its limit, without counting. */
  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > this.now() && entry.count > this.limit;
  }
}

/** The largest request body: messages and approvals are small. */
export const MAX_BODY_BYTES = "1mb";
export const MAX_REQUESTS_PER_MINUTE = 1200;
export const MAX_FAILED_AUTH_PER_MINUTE = 20;

/** Per-address request limit. */
export function rateLimitMiddleware(
  limiter: WindowCounter = new WindowCounter(MAX_REQUESTS_PER_MINUTE, 60_000),
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (limiter.hit(req.socket.remoteAddress ?? "unknown")) {
      next();
      return;
    }
    res.status(429).json({ error: "Too many requests." });
  };
}

/**
 * Refuse every protocol upgrade. The server has no WebSocket route; a page
 * that tries one (from any origin) is told no instead of left hanging.
 */
export function refuseUpgrades(server: http.Server): void {
  server.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
}

/** Body-parser failures as JSON: 413 for a body over the limit, 400 for bad JSON. */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 413) {
    res.status(413).json({ error: "The request body is too large." });
  } else if (status === 400) {
    res.status(400).json({ error: "The request body is not valid JSON." });
  } else {
    res.status(500).json({ error: "The server could not handle the request." });
  }
};

/**
 * The token for a server URL when none was given: the file a local
 * `cn serve` wrote, read only for a loopback URL so the token never goes
 * to another host.
 */
export function tokenForUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!isLoopbackHost(u.hostname)) return undefined;
    const port = portOfUrl(url);
    return port ? readServeTokenFile(port) : undefined;
  } catch {
    return undefined;
  }
}
