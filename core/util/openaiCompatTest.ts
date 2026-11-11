/**
 * "Test connection" for an OpenAI-compatible endpoint (OpenAI, Ollama's /v1,
 * llama.cpp, LM Studio, vLLM, llamafile, text-gen-webui, Msty, and any custom
 * apiBase). Three steps, each of which can fail on its own:
 *   1. `GET {base}/models`: reachable, key accepted, which models are listed.
 *   2. Server hints, never fatal: Ollama `/api/show` (does the server parse
 *      this model's calls itself) and llama.cpp `/props` (what template).
 *   3. With a model, one non-streaming chat request offering a made-up tool,
 *      classified by the same probe the Bedrock tester uses. The calls in the
 *      reply are never run.
 * The sender is `fetchFn`, so tests record bodies and nothing leaves the
 * machine. The key is only ever sent as a bearer header and never returned.
 */
import { getOllamaShowHint } from "./ollamaShowHint.js";
import { surfaceForProvider } from "./surfaceFacts.js";
import { hintFromLlamaCppProps } from "./toolDialectMetadata.js";
import { probeToolDialect, type ToolCallSupport } from "./toolDialectProbe.js";

export interface OpenAICompatTestInput {
  provider: string;
  apiBase?: string;
  apiKey?: string;
  /** Model to probe for tool calls; without one only the listing runs. */
  model?: string;
  timeoutMs?: number;
  fetchFn?: TestFetch;
}

export type TestFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface OpenAICompatProbe {
  ok: true;
  label: string;
  kind: ToolCallSupport["kind"];
  preset?: string;
  facts?: string;
  /** The server parses this model's calls itself (Ollama). */
  serverParses?: boolean;
}

export type OpenAICompatTestResult =
  | {
      ok: true;
      models: string[];
      probe?: OpenAICompatProbe | { ok: false; error: string };
      /** Template line from llama.cpp /props or Ollama /api/show, when the server answered. */
      template?: string;
    }
  | { ok: false; error: string };

const DEFAULT_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
  "llama.cpp": "http://127.0.0.1:8080/v1",
  llamafile: "http://127.0.0.1:8080/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  vllm: "http://127.0.0.1:8000/v1",
  "text-gen-webui": "http://127.0.0.1:5000/v1",
  msty: "http://127.0.0.1:10000/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
};

/** Providers this tester knows a default endpoint for; any other needs an apiBase. */
export function hasOpenAICompatDefault(provider: string): boolean {
  return Object.hasOwn(DEFAULT_BASES, provider);
}

/** The OpenAI-compatible base URL (ends in /v1 for the local servers), no trailing slash. */
export function openAICompatBase(
  provider: string,
  apiBase?: string,
): string | undefined {
  const raw = (apiBase?.trim() || DEFAULT_BASES[provider])?.replace(/\/+$/, "");
  if (!raw) return undefined;
  // Ollama's native base has no /v1; its OpenAI surface does.
  return provider === "ollama" && !/\/v1$/.test(raw) ? `${raw}/v1` : raw;
}

/** Strip secrets that an error body may echo back. */
function scrub(text: string, key?: string): string {
  let t = text.slice(0, 300);
  if (key) t = t.split(key).join("[key]");
  return t.replace(/\s+/g, " ").trim();
}

function describeFailure(
  status: number,
  body: string,
  key: string | undefined,
): string {
  if (status === 401 || status === 403) {
    return `The server rejected the API key (HTTP ${status}).`;
  }
  if (status === 404) {
    return "The server answered 404 for /models. Check the API base (it usually ends in /v1).";
  }
  const detail = scrub(body, key);
  return `The server answered HTTP ${status}${detail ? `: ${detail}` : ""}.`;
}

/** Run one request with a timeout; a thrown error becomes a message. */
async function call(
  input: OpenAICompatTestInput,
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string; body: string }
> {
  const fetchFn = input.fetchFn ?? (globalThis.fetch as unknown as TestFetch);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 30_000);
  try {
    const res = await fetchFn(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: "", body: text };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    const msg = aborted
      ? "timed out"
      : scrub(e instanceof Error ? e.message : String(e), input.apiKey);
    return {
      ok: false,
      status: 0,
      error: `Could not reach ${url.replace(/\?.*$/, "")}: ${msg}.`,
      body: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function modelIds(data: unknown): string[] {
  const list = (data as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

/** llama.cpp's template line, from `/props` at the server root. */
async function llamaCppTemplate(
  input: OpenAICompatTestInput,
  base: string,
): Promise<string | undefined> {
  if (input.provider !== "llama.cpp" && input.provider !== "llamafile") return;
  const res = await call(input, `${base.replace(/\/v1$/, "")}/props`, "GET");
  if (!res.ok) return;
  const hint = hintFromLlamaCppProps(res.data);
  return hint.signal
    ? `Server template looks like ${hint.signal.dialect} (llama.cpp /props).`
    : undefined;
}

function templateNoteFor(
  template: string | undefined,
  support: ToolCallSupport,
): string | undefined {
  if (!template) return undefined;
  return support.kind === "text"
    ? `${template} Its parser left the call in text.`
    : template;
}

/** Test one endpoint; never throws. */
export async function testOpenAICompatConnection(
  input: OpenAICompatTestInput,
): Promise<OpenAICompatTestResult> {
  const base = openAICompatBase(input.provider, input.apiBase);
  if (!base) return { ok: false, error: "Enter the API base URL first." };
  const listed = await call(input, `${base}/models`, "GET");
  if (!listed.ok) {
    return {
      ok: false,
      error:
        listed.error ||
        describeFailure(listed.status, listed.body, input.apiKey),
    };
  }
  const models = modelIds(listed.data);
  if (!input.model) return { ok: true, models };

  const show = await getOllamaShowHint({
    provider: input.provider,
    apiBase: base,
    model: input.model,
    fetchFn: input.fetchFn
      ? (url, init) =>
          input.fetchFn!(url, init).then((r) => ({
            ok: r.ok,
            json: () => r.json(),
          }))
      : undefined,
  });
  const template = await llamaCppTemplate(input, base);
  const surface = surfaceForProvider(input.provider);
  const result = await probeToolDialect(
    async (probe) => {
      const res = await call(input, `${base}/chat/completions`, "POST", {
        model: input.model,
        messages: probe.messages,
        tools: probe.tools,
        tool_choice: probe.params.tool_choice,
        temperature: probe.params.temperature,
        max_tokens: probe.params.max_tokens,
        stream: false,
      });
      if (!res.ok) {
        // A 4xx that names tools is a refusal; anything else is "unknown".
        throw new Error(
          res.error || describeFailure(res.status, res.body, input.apiKey),
        );
      }
      const msg = (
        res.data as {
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: {
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
        }
      ).choices?.[0]?.message;
      return {
        content: msg?.content ?? "",
        toolCalls: (msg?.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? "",
        })),
      };
    },
    input.model,
    {
      serverParses: show?.serverParses,
      toolsAdvertised: show?.toolsAdvertised,
      ...(surface ? { surface } : {}),
    },
  );
  const note = templateNoteFor(template, result.support);
  return {
    ok: true,
    models,
    ...(note ? { template: note } : {}),
    probe: {
      ok: true,
      label: result.label,
      kind: result.support.kind,
      ...(result.preset ? { preset: result.preset } : {}),
      ...(result.facts ? { facts: result.facts } : {}),
      ...(result.serverParses ? { serverParses: true } : {}),
    },
  };
}
