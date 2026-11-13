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
import {
  hasOpenAICompatDefault,
  openAICompatBase,
  openAICompatDefaultBase,
} from "./openaiCompatBases.js";
import {
  fingerprintOf,
  findMeasured,
  measuredFactsOf,
  type MeasuredEntry,
  recordingEnabled,
  recordProbe,
} from "./measuredFacts.js";
import { testAnthropicConnection } from "./anthropicSurfaceTest.js";
import type { RetirementNotice } from "./modelRetirement.js";
import { recordLive } from "./retirementNoticeState.js";
import { getOllamaShowHint } from "./ollamaShowHint.js";
import { surfaceForProvider } from "./surfaceFacts.js";
import { recoverableDialect } from "./toolDialectLeak.js";
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
  /**
   * Write the result to the local measured-facts file (default true). The
   * user setting `probes.record: false` also turns it off.
   */
  record?: boolean;
  /** For tests: the measured-facts file and today's date. */
  measuredFile?: string;
  now?: string;
  /** For tests: the retirement-notice state file (Anthropic only). */
  noticeFile?: string;
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
  /** `toolDialect` value that would recover the calls the model wrote as text. */
  recoveryDialect?: string;
  /** The result was added to the local measured-facts file; n is the probe count there. */
  recorded?: { n: number };
}

export type OpenAICompatTestResult =
  | {
      ok: true;
      models: string[];
      probe?: OpenAICompatProbe | { ok: false; error: string };
      /** Template line from llama.cpp /props or Ollama /api/show, when the server answered. */
      template?: string;
      /** Anthropic only: deprecation or retirement notices for the tested model. */
      retirement?: RetirementNotice[];
    }
  | { ok: false; error: string };

/** The API surface this tester measures. */
const API = "openai-chat";

export { hasOpenAICompatDefault, openAICompatBase, openAICompatDefaultBase };

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

/**
 * Anthropic's surface: list the models with the user's key and read their
 * lifecycle (core/util/anthropicSurfaceTest.ts). The lifecycle fields are kept
 * locally so the model chip and the start-up notice can use them offline.
 */
async function testAnthropic(
  input: OpenAICompatTestInput,
): Promise<OpenAICompatTestResult> {
  const today = input.now ?? new Date().toISOString().slice(0, 10);
  const res = await testAnthropicConnection({
    apiKey: input.apiKey,
    apiBase: input.apiBase,
    models: input.model ? [input.model] : [],
    timeoutMs: input.timeoutMs,
    fetchFn: input.fetchFn,
    now: today,
  });
  if (!res.ok) return res;
  if (input.record !== false && recordingEnabled()) {
    for (const m of res.listed) {
      if (m.retiresAt || (m.lifecycle && m.lifecycle !== "active")) {
        recordLive(m.id, m, today, input.noticeFile);
      }
    }
  }
  return {
    ok: true,
    models: res.models,
    ...(res.notices.length ? { retirement: res.notices } : {}),
  };
}

/** Test one endpoint; never throws. */
export async function testOpenAICompatConnection(
  input: OpenAICompatTestInput,
): Promise<OpenAICompatTestResult> {
  if (input.provider === "anthropic") return testAnthropic(input);
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
  const prior = findMeasured(
    { provider: input.provider, apiBase: base, model: input.model, api: API },
    input.measuredFile,
  );
  let shape: string | undefined;
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
      shape = fingerprintOf(res.data);
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
      ...(prior ? { measured: measuredFactsOf(prior) } : {}),
    },
  );
  const recorded = recordResult(input, base, result.support, shape, {
    skipped: show?.toolsAdvertised === false,
  });
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
      ...(recoveryDialect(result.support, result.serverParses)
        ? {
            recoveryDialect: recoveryDialect(
              result.support,
              result.serverParses,
            ),
          }
        : {}),
      ...(recorded ? { recorded: { n: recorded.n } } : {}),
    },
  };
}

/** The `toolDialect` that would recover a call written as text, unless the server parses calls itself. */
function recoveryDialect(
  support: ToolCallSupport,
  serverParses: boolean | undefined,
): string | undefined {
  return support.kind === "text" && !serverParses
    ? recoverableDialect(support.dialect)
    : undefined;
}

/**
 * Add the probe to the local measured-facts file (core/util/measuredFacts.ts)
 * unless recording is off. A probe that never ran (the server lists no tools
 * capability) or could not tell is not a measurement and is not written.
 */
function recordResult(
  input: OpenAICompatTestInput,
  base: string,
  support: ToolCallSupport,
  shape: string | undefined,
  opts: { skipped: boolean },
): MeasuredEntry | undefined {
  if (opts.skipped || !input.model) return undefined;
  if (input.record === false || !recordingEnabled()) return undefined;
  if (support.kind === "unknown") return undefined;
  return recordProbe(
    {
      provider: input.provider,
      apiBase: base,
      model: input.model,
      api: API,
      outcome: support.kind === "native" ? "native" : support.kind,
      ...(support.kind === "text" ? { dialect: support.dialect } : {}),
      fingerprint: shape ?? "no-reply",
      now: input.now ?? new Date().toISOString().slice(0, 10),
    },
    input.measuredFile,
  );
}
