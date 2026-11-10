import type { ToolCallLike } from "../../../util/toolDialectDetect";
import type { RawReply } from "./fixture";
import type { Temperature } from "./plan";
import type { WireTool } from "./tools";

/** One request in a form both transports build their own wire body from. */
export interface CaptureRequest {
  model: string;
  stream: boolean;
  temperature: Temperature;
  system: string;
  prompt: string;
  tools: WireTool[];
  maxTokens: number;
}

export interface CaptureClient {
  send(req: CaptureRequest): Promise<RawReply>;
}

/* ---------------------------- Bedrock Converse --------------------------- */

export function bedrockInput(req: CaptureRequest) {
  return {
    modelId: req.model,
    system: [{ text: req.system }],
    messages: [{ role: "user", content: [{ text: req.prompt }] }],
    toolConfig: {
      tools: req.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      })),
    },
    inferenceConfig: {
      maxTokens: req.maxTokens,
      ...(req.temperature === "default"
        ? {}
        : { temperature: req.temperature }),
    },
  };
}

interface ConverseBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
}

export function parseConverse(out: any): RawReply {
  const blocks: ConverseBlock[] = out?.output?.message?.content ?? [];
  const toolCalls: ToolCallLike[] = [];
  let text = "";
  for (const b of blocks) {
    if (typeof b.text === "string") text += b.text;
    if (b.toolUse) {
      toolCalls.push({
        id: b.toolUse.toolUseId,
        name: b.toolUse.name ?? "",
        arguments: JSON.stringify(b.toolUse.input ?? {}),
      });
    }
  }
  return {
    text,
    toolCalls,
    stopReason: out?.stopReason,
    usage: {
      inputTokens: out?.usage?.inputTokens,
      outputTokens: out?.usage?.outputTokens,
    },
  };
}

/** Fold ConverseStream events into one reply, keeping the text delta boundaries. */
export async function collectConverseStream(
  events: AsyncIterable<any>,
): Promise<RawReply> {
  const chunks: string[] = [];
  const calls = new Map<number, ToolCallLike>();
  let stopReason: string | undefined;
  let usage: RawReply["usage"];
  for await (const e of events) {
    const idx: number =
      e.contentBlockStart?.contentBlockIndex ??
      e.contentBlockDelta?.contentBlockIndex ??
      0;
    const start = e.contentBlockStart?.start?.toolUse;
    if (start) {
      calls.set(idx, {
        id: start.toolUseId,
        name: start.name ?? "",
        arguments: "",
      });
    }
    const delta = e.contentBlockDelta?.delta;
    if (typeof delta?.text === "string" && delta.text) chunks.push(delta.text);
    if (delta?.toolUse?.input !== undefined) {
      const c = calls.get(idx) ?? { name: "", arguments: "" };
      c.arguments += delta.toolUse.input;
      calls.set(idx, c);
    }
    if (e.messageStop) stopReason = e.messageStop.stopReason;
    if (e.metadata?.usage) {
      usage = {
        inputTokens: e.metadata.usage.inputTokens,
        outputTokens: e.metadata.usage.outputTokens,
      };
    }
  }
  const toolCalls = [...calls.values()].map((c) => ({
    ...c,
    arguments: c.arguments || "{}",
  }));
  return { text: chunks.join(""), toolCalls, stopReason, usage, chunks };
}

/**
 * The AWS SDK client for a profile and region. The SDK is imported when the
 * client is built, so planning and the tests never load it.
 */
export async function createBedrockClient(opts: {
  region: string;
  profile?: string;
}): Promise<CaptureClient> {
  const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } =
    await import("@aws-sdk/client-bedrock-runtime");
  const { fromNodeProviderChain } =
    await import("@aws-sdk/credential-providers");
  const client = new BedrockRuntimeClient({
    region: opts.region,
    credentials: fromNodeProviderChain({ profile: opts.profile }),
  });
  return {
    async send(req) {
      const input = bedrockInput(req) as any;
      if (!req.stream) {
        return parseConverse(await client.send(new ConverseCommand(input)));
      }
      const res = await client.send(new ConverseStreamCommand(input));
      return collectConverseStream(res.stream as AsyncIterable<any>);
    },
  };
}

/* ------------------------- OpenAI-compatible server ---------------------- */

export function openAiBody(req: CaptureRequest) {
  return {
    model: req.model,
    stream: req.stream,
    max_tokens: req.maxTokens,
    ...(req.temperature === "default" ? {} : { temperature: req.temperature }),
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.prompt },
    ],
    tools: req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  };
}

export function parseChatCompletion(out: any): RawReply {
  const choice = out?.choices?.[0];
  const toolCalls: ToolCallLike[] = (choice?.message?.tool_calls ?? []).map(
    (c: any) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
    }),
  );
  return {
    text: choice?.message?.content ?? "",
    toolCalls,
    stopReason: choice?.finish_reason ?? undefined,
    usage: {
      inputTokens: out?.usage?.prompt_tokens,
      outputTokens: out?.usage?.completion_tokens,
    },
  };
}

/** Fold the `data:` lines of a chat-completion stream into one reply. */
export async function collectChatStream(
  lines: AsyncIterable<string>,
): Promise<RawReply> {
  const chunks: string[] = [];
  const calls = new Map<number, ToolCallLike>();
  let stopReason: string | undefined;
  let usage: RawReply["usage"];
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt: any;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }
    if (evt.usage) {
      usage = {
        inputTokens: evt.usage.prompt_tokens,
        outputTokens: evt.usage.completion_tokens,
      };
    }
    const choice = evt.choices?.[0];
    if (!choice) continue;
    const content = choice.delta?.content;
    if (typeof content === "string" && content) chunks.push(content);
    for (const tc of choice.delta?.tool_calls ?? []) {
      const i: number = tc.index ?? 0;
      const c = calls.get(i) ?? { name: "", arguments: "" };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
      calls.set(i, c);
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }
  const toolCalls = [...calls.values()].map((c) => ({
    ...c,
    arguments: c.arguments || "{}",
  }));
  return { text: chunks.join(""), toolCalls, stopReason, usage, chunks };
}

async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

/** An OpenAI-compatible base URL (Ollama, Strata, vLLM, LM Studio). */
export function createOpenAiClient(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): CaptureClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async send(req) {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(openAiBody(req)),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      if (!req.stream) return parseChatCompletion(await res.json());
      return collectChatStream(readLines(res.body!));
    },
  };
}
