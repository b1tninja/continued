/**
 * What an Ollama server says about a model, fetched once per model per process
 * (POST /api/show, no generation, no model load) and reduced to the two facts
 * the tool-dialect notices need: whether the server parses the model's tool
 * calls itself, and whether it advertises the `tools` capability. A failure
 * is no hint, never an error. Pure parts are in toolDialectMetadata.ts.
 */
import { hintFromOllamaShow } from "./toolDialectMetadata.js";

export interface OllamaShowHint {
  /** Ollama named a parser that handles tool calls for this model. Unset when unknown. */
  serverParses?: boolean;
  /** `capabilities` was listed: whether it includes `tools`. Unset when not listed. */
  toolsAdvertised?: boolean;
}

export const OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434";
export const OLLAMA_SHOW_TIMEOUT_MS = 2000;

/** The Ollama root for a configured base URL (an OpenAI-compatible one ends in /v1), or undefined when it is not Ollama's. */
export function ollamaBaseFor(
  provider: string | undefined,
  apiBase: string | undefined,
): string | undefined {
  if (!apiBase) return provider === "ollama" ? OLLAMA_DEFAULT_BASE : undefined;
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return undefined;
  }
  if (provider !== "ollama" && url.port !== "11434") return undefined;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const cache = new Map<string, Promise<OllamaShowHint | undefined>>();

/** Forget cached hints (tests). */
export function resetOllamaShowCache(): void {
  cache.clear();
}

/** The cached hint for one model; undefined when the server did not answer in time or is not Ollama. */
export function getOllamaShowHint(args: {
  provider?: string;
  apiBase?: string;
  model: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}): Promise<OllamaShowHint | undefined> {
  const base = ollamaBaseFor(args.provider, args.apiBase);
  if (!base || !args.model) return Promise.resolve(undefined);
  const key = `${base}\n${args.model}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = fetchHint(base, args);
    cache.set(key, hit);
  }
  return hit;
}

async function fetchHint(
  base: string,
  args: { model: string; fetchFn?: FetchLike; timeoutMs?: number },
): Promise<OllamaShowHint | undefined> {
  const fetchFn = args.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(),
    args.timeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS,
  );
  try {
    const res = await fetchFn(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: args.model }),
      signal: ctl.signal,
    });
    if (!res.ok) return undefined;
    const h = hintFromOllamaShow(await res.json(), args.model);
    return {
      ...(h.serverParses !== undefined ? { serverParses: h.serverParses } : {}),
      ...(h.toolsAdvertised !== undefined
        ? { toolsAdvertised: h.toolsAdvertised }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
