import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const USER_AGENT = `continuous-model-research/${VERSION} (+https://github.com/b1tninja/continuous)`;
const ALLOWED_HOST = "huggingface.co";
// Never request weights; only small metadata files.
const RAW_ALLOW =
  /^(README\.md|config\.json|generation_config\.json|tokenizer_config\.json|chat_template\.[\w.-]+)$/;

export class FetchError extends Error {}
export class StopError extends FetchError {}

export function defaultCacheDir() {
  return join(tmpdir(), "continuous-model-research-cache");
}

export function checkUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== ALLOWED_HOST) {
    throw new FetchError(
      `refusing ${u.hostname}: only https://${ALLOWED_HOST}`,
    );
  }
  const raw = u.pathname.match(/^\/[^/]+\/[^/]+\/raw\/[^/]+\/(.+)$/);
  if (raw && !RAW_ALLOW.test(raw[1])) {
    throw new FetchError(`refusing file ${raw[1]}: not on the allowlist`);
  }
  if (!raw && !u.pathname.startsWith("/api/models/")) {
    throw new FetchError(`refusing path ${u.pathname}`);
  }
  return u;
}

/** `"api";r=499;t=300` -> { remaining: 499, reset: 300 } */
export function parseRateLimit(h) {
  if (!h) return null;
  const r = /;\s*r=(\d+)/.exec(h);
  const t = /;\s*t=(\d+)/.exec(h);
  return r ? { remaining: Number(r[1]), reset: t ? Number(t[1]) : null } : null;
}

/**
 * Polite client: no credentials (HF_TOKEN and friends are never read), one
 * request at a time with a pause, conditional GET against an on-disk cache keyed
 * by URL, a request budget, and a hard stop on 429 or an exhausted rate-limit
 * window. Redirects are followed only within the same host.
 */
export function createClient({
  cacheDir = defaultCacheDir(),
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minDelayMs = 200,
  budget = 100,
  offline = false,
  log = () => {},
} = {}) {
  mkdirSync(cacheDir, { recursive: true });
  let used = 0;
  let last = 0;
  const key = (url) => createHash("sha256").update(url).digest("hex");

  function readCache(url) {
    const k = join(cacheDir, key(url));
    if (!existsSync(k + ".json")) return null;
    const meta = JSON.parse(readFileSync(k + ".json", "utf8"));
    const body = existsSync(k + ".body")
      ? readFileSync(k + ".body", "utf8")
      : "";
    return { meta, body };
  }
  function writeCache(url, meta, body) {
    const k = join(cacheDir, key(url));
    writeFileSync(k + ".json", JSON.stringify(meta));
    writeFileSync(k + ".body", body);
  }

  async function get(url) {
    checkUrl(url);
    const cached = readCache(url);
    if (offline) {
      if (!cached) throw new FetchError(`offline and not cached: ${url}`);
      return { ...cached.meta, body: cached.body, fromCache: true };
    }
    let target = url;
    for (let hop = 0; hop < 3; hop++) {
      if (used >= budget) {
        throw new StopError(`request budget of ${budget} reached`);
      }
      const wait = minDelayMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      const headers = { "user-agent": USER_AGENT, accept: "*/*" };
      if (cached?.meta.etag && target === url) {
        headers["if-none-match"] = cached.meta.etag;
      }
      used++;
      last = Date.now();
      let res;
      try {
        res = await fetchImpl(target, { headers, redirect: "manual" });
      } catch (e) {
        throw new FetchError(`network error for ${target}: ${e.message}`);
      }
      const rl = res.headers.get("ratelimit");
      const info = parseRateLimit(rl);
      if (res.status === 429) {
        throw new StopError(
          `429 for ${target}; Retry-After=${res.headers.get("retry-after")} RateLimit=${rl}. Stopping, not retrying.`,
        );
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get("location");
        await res.arrayBuffer();
        if (!loc) throw new FetchError(`redirect without location: ${target}`);
        target = new URL(loc, target).href;
        checkUrl(target); // throws on another host
        continue;
      }
      const meta = {
        status: res.status,
        etag: res.headers.get("etag"),
        commit: res.headers.get("x-repo-commit"),
        fetchedAt: new Date().toISOString(),
        url,
      };
      const body = await res.text();
      const exhausted = info && info.remaining <= 1;
      if (res.status === 304 && cached) {
        log(`304 ${url}`);
        writeCache(
          url,
          { ...cached.meta, fetchedAt: meta.fetchedAt },
          cached.body,
        );
        if (exhausted) {
          throw new StopError(`rate-limit window used up (${rl}); stopping`);
        }
        return { ...cached.meta, body: cached.body, fromCache: true };
      }
      if (res.status >= 500)
        throw new FetchError(`HTTP ${res.status} for ${url}`);
      writeCache(url, meta, body);
      if (exhausted) {
        throw new StopError(`rate-limit window used up (${rl}); stopping`);
      }
      return { ...meta, body, fromCache: false };
    }
    throw new FetchError(`too many redirects for ${url}`);
  }

  return {
    get,
    get used() {
      return used;
    },
  };
}
