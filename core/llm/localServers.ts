import type { FetchedModel } from "./fetchModels.js";

/** An OpenAI-compatible server that usually runs on this machine. */
export interface LocalServerPreset {
  title: string;
  /** Includes the `/v1/` path the server serves the OpenAI API under. */
  apiBase: string;
}

/**
 * The default address of each common local server. llama.cpp's
 * `llama-server` (and Strata, llamafile and LocalAI, which keep its port)
 * comes first: 8080 is the most common local default.
 */
export const LOCAL_SERVER_PRESETS: LocalServerPreset[] = [
  { title: "llama.cpp / Strata", apiBase: "http://127.0.0.1:8080/v1/" },
  { title: "vLLM", apiBase: "http://127.0.0.1:8000/v1/" },
  { title: "LM Studio", apiBase: "http://127.0.0.1:1234/v1/" },
  { title: "Ollama", apiBase: "http://127.0.0.1:11434/v1/" },
  { title: "Lemonade", apiBase: "http://127.0.0.1:8000/api/v1/" },
  { title: "SGLang", apiBase: "http://127.0.0.1:30000/v1/" },
  { title: "text-generation-webui", apiBase: "http://127.0.0.1:5000/v1/" },
  { title: "KoboldCpp", apiBase: "http://127.0.0.1:5001/v1/" },
  { title: "Jan", apiBase: "http://127.0.0.1:1337/v1/" },
];

/**
 * Ports a second llama.cpp-style server usually takes: the next ones after
 * 8080. Detection tries them too, so a server moved off 8080 is still found.
 */
const EXTRA_LLAMACPP_PORTS = [
  8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089,
];

export interface DetectedLocalServer {
  title: string;
  apiBase: string;
  /** Empty when the server is up but has no model loaded, or needs a key. */
  models: FetchedModel[];
  /** The server refused the request without an API key. */
  needsKey?: boolean;
}

type FetchFn = typeof fetch;

/**
 * The context window a server reports for one `/v1/models` entry. Each
 * server names it differently: llama.cpp and Strata `meta.n_ctx`, vLLM
 * `max_model_len`, LM Studio `max_context_length` (or the loaded
 * `loaded_context_length`), OpenRouter and others `context_length`.
 */
export function contextLengthOf(entry: any): number | undefined {
  const candidates = [
    entry?.meta?.n_ctx,
    entry?.max_model_len,
    entry?.loaded_context_length,
    entry?.max_context_length,
    entry?.context_length,
    entry?.meta?.n_ctx_train,
  ];
  for (const value of candidates) {
    const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** False for entries that only produce something other than text (image models). */
function producesText(entry: any): boolean {
  const outputs = entry?.architecture?.output_modalities;
  return !Array.isArray(outputs) || outputs.includes("text");
}

function withSlash(apiBase: string): string {
  return apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
}

class LocalServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function getModels(
  apiBase: string,
  apiKey: string | undefined,
  fetchFn: FetchFn,
  timeoutMs?: number,
): Promise<FetchedModel[]> {
  const response = await fetchFn(new URL("models", withSlash(apiBase)), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) {
    throw new LocalServerError(
      `${response.status} ${response.statusText} from ${apiBase}models`,
      response.status,
    );
  }
  const data = await response.json();
  const entries: any[] = Array.isArray(data) ? data : (data?.data ?? []);
  return entries
    .filter((m) => typeof m?.id === "string" && producesText(m))
    .map((m) => {
      const contextLength = contextLengthOf(m);
      return {
        name: m.id,
        modelId: m.id,
        ...(contextLength ? { contextLength } : {}),
      };
    });
}

/**
 * The models an OpenAI-compatible server lists at `<apiBase>models`, with the
 * context window it reports for each.
 */
export async function listOpenAICompatibleModels(
  apiBase: string,
  apiKey?: string,
  fetchFn: FetchFn = fetch,
): Promise<FetchedModel[]> {
  return getModels(apiBase, apiKey, fetchFn);
}

/** True when the server at this address answers `/v1/status` as Strata. */
async function isStrata(
  apiBase: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetchFn(new URL("status", withSlash(apiBase)), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.service === "strata";
  } catch {
    return false;
  }
}

async function probe(
  preset: LocalServerPreset,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<DetectedLocalServer | undefined> {
  try {
    const models = await getModels(
      preset.apiBase,
      undefined,
      fetchFn,
      timeoutMs,
    );
    const strata = await isStrata(preset.apiBase, fetchFn, timeoutMs);
    return { ...preset, title: strata ? "Strata" : preset.title, models };
  } catch (e) {
    if (
      e instanceof LocalServerError &&
      (e.status === 401 || e.status === 403)
    ) {
      return { ...preset, models: [], needsKey: true };
    }
    return undefined; // nothing listening, or not an OpenAI-compatible server
  }
}

/**
 * Look for OpenAI-compatible servers on this machine: every preset address,
 * plus ports 8081-8089 for a llama.cpp-style server moved off 8080. A port is
 * reported once, under the first preset that answers on it.
 */
export async function detectLocalServers(
  options: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<DetectedLocalServer[]> {
  const { fetchFn = fetch, timeoutMs = 1500 } = options;
  const candidates: LocalServerPreset[] = [
    ...LOCAL_SERVER_PRESETS,
    ...EXTRA_LLAMACPP_PORTS.map((port) => ({
      title: "llama.cpp / Strata",
      apiBase: `http://127.0.0.1:${port}/v1/`,
    })),
  ];
  const results = await Promise.all(
    candidates.map((c) => probe(c, fetchFn, timeoutMs)),
  );
  const seenPorts = new Set<string>();
  const found: DetectedLocalServer[] = [];
  for (const server of results) {
    if (!server) continue;
    const port = new URL(server.apiBase).port;
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    found.push(server);
  }
  return found;
}
