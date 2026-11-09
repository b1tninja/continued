import { describe, expect, it, vi } from "vitest";

const mockedFetch = vi.hoisted(() => vi.fn());
vi.mock("../util.js", async (orig) => ({
  ...(await orig<typeof import("../util.js")>()),
  customFetch: () => mockedFetch,
}));

import { AnthropicApi } from "./Anthropic.js";
import { thinkingRequestFor } from "./anthropicThinking.js";

const make = (effort?: string) =>
  new AnthropicApi({
    provider: "anthropic",
    apiKey: "k",
    requestOptions: effort
      ? { extraBodyProperties: { reasoning_effort: effort } }
      : undefined,
  } as any);

const MODEL = "claude-sonnet-4-5";

const toolCall = (id: string) => ({
  id,
  type: "function",
  function: { name: "read", arguments: "{}" },
});

const loop = () => [
  { role: "system", content: "be brief" },
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: null, tool_calls: [toolCall("t1")] },
  { role: "tool", tool_call_id: "t1", content: "contents" },
];

function sse(events: object[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events)
          c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const delta = (index: number, d: object) => ({
  type: "content_block_delta",
  index,
  delta: d,
});
const stop = (index: number) => ({ type: "content_block_stop", index });

/** A reply that thinks (signed), then calls tool t1. */
const thinkingToolReply = (extraStart: object[] = []) => [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  },
  delta(0, { type: "thinking_delta", thinking: "hmm " }),
  delta(0, { type: "thinking_delta", thinking: "ok" }),
  delta(0, { type: "signature_delta", signature: "SIG" }),
  stop(0),
  ...extraStart,
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
  },
  delta(1, { type: "input_json_delta", partial_json: "{}" }),
  stop(1),
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
];

async function drain(api: AnthropicApi, events: object[]) {
  const chunks: any[] = [];
  for await (const c of api.handleStreamResponse(sse(events), MODEL)) {
    chunks.push(c);
  }
  return chunks;
}

describe("thinkingRequestFor", () => {
  it("maps efforts to the GUI budgets", () => {
    const b = (e: string) =>
      (thinkingRequestFor(MODEL, undefined, e)!.thinking as any).budget_tokens;
    expect(b("minimal")).toBe(1024);
    expect(b("low")).toBe(1024);
    expect(b("medium")).toBe(4096);
    expect(b("high")).toBe(16384);
    expect(b("xhigh")).toBe(16384);
    expect(b("max")).toBe(16384);
  });

  it("sends nothing for none, off or unset", () => {
    expect(thinkingRequestFor(MODEL, undefined, "none")).toBeUndefined();
    expect(thinkingRequestFor(MODEL, undefined, "off")).toBeUndefined();
    expect(thinkingRequestFor(MODEL, undefined, undefined)).toBeUndefined();
    expect(thinkingRequestFor(MODEL, "none", "high")).toBeUndefined();
  });

  it("lets the body's effort win over the config's", () => {
    const t = thinkingRequestFor(MODEL, "low", "high")!;
    expect((t.thinking as any).budget_tokens).toBe(1024);
  });

  it("uses adaptive thinking with output_config.effort on newer models", () => {
    const t = thinkingRequestFor("claude-opus-4-6", undefined, "medium")!;
    expect(t.thinking).toEqual({ type: "adaptive" });
    expect(t.output_config).toEqual({ effort: "medium" });
  });
});

describe("AnthropicApi request with reasoning_effort", () => {
  it("is unchanged without an effort", () => {
    const body = (make() as any)._convertBody({
      model: MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(32_000);
  });

  it("sends thinking from the config's extraBodyProperties", () => {
    const body = (make("medium") as any)._convertBody({
      model: MODEL,
      temperature: 0.2,
      top_p: 0.5,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it("keeps max_tokens above the budget", () => {
    const body = (make("high") as any)._convertBody({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
    const small = (make("high") as any)._convertBody({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(small.max_tokens).toBeGreaterThan(16384);
  });

  it("leaves thinking off when a tool choice is forced", () => {
    const body = (make("high") as any)._convertBody({
      model: MODEL,
      tool_choice: "required",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.thinking).toBeUndefined();
  });

  it("leaves thinking off in a tool loop whose thinking blocks are unknown", () => {
    const body = (make("high") as any)._convertBody({
      model: MODEL,
      messages: loop(),
    });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(32_000);
    expect(JSON.stringify(body.messages)).not.toContain('"thinking"');
  });

  it("allows thinking on a fresh turn after plain history", () => {
    const body = (make("low") as any)._convertBody({
      model: MODEL,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
      ],
    });
    expect(body.thinking).toBeDefined();
  });
});

describe("AnthropicApi thinking round trip", () => {
  it("streams reasoning and puts the signed block back before the tool_use", async () => {
    const api = make("medium");
    const chunks = await drain(api, thinkingToolReply());

    const text = chunks
      .map((c) => (c.choices[0]?.delta as any)?.reasoning_content ?? "")
      .join("");
    expect(text).toBe("hmm ok");
    expect(
      chunks.some(
        (c) =>
          (c.choices[0]?.delta as any)?.reasoning_details?.[0]?.signature ===
          "SIG",
      ),
    ).toBe(true);

    const body = (api as any)._convertBody({ model: MODEL, messages: loop() });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    const assistant = body.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toEqual({
      type: "thinking",
      thinking: "hmm ok",
      signature: "SIG",
    });
    expect(assistant.content[1].type).toBe("tool_use");
  });

  it("round-trips redacted_thinking too", async () => {
    const api = make("medium");
    const events = thinkingToolReply().filter(
      (e: any) => e.index !== 0 || e.type === "message_start",
    );
    events.splice(1, 0, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "ENC" },
    });
    events.splice(2, 0, stop(0));
    await drain(api, events);
    const body = (api as any)._convertBody({ model: MODEL, messages: loop() });
    expect(body.messages[1].content[0]).toEqual({
      type: "redacted_thinking",
      data: "ENC",
    });
  });

  it("does not store a thinking block that has no signature", async () => {
    const api = make("medium");
    await drain(
      api,
      thinkingToolReply().filter(
        (e: any) => e.delta?.type !== "signature_delta",
      ),
    );
    const body = (api as any)._convertBody({ model: MODEL, messages: loop() });
    // Nothing safe to send back: thinking stays off rather than 400ing
    expect(body.thinking).toBeUndefined();
    expect(JSON.stringify(body.messages)).not.toContain('"thinking"');
  });

  it("does not send stored blocks when thinking is off for the request", async () => {
    const api = make("medium");
    await drain(api, thinkingToolReply());
    const body = (api as any)._convertBody({
      model: MODEL,
      reasoning_effort: "none",
      messages: loop(),
    });
    expect(body.thinking).toBeUndefined();
    expect(body.messages[1].content[0].type).toBe("tool_use");
  });
});

describe("AnthropicApi non-streaming reply with thinking", () => {
  it("reads the text block, not content[0]", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "m1",
          content: [
            { type: "thinking", thinking: "x", signature: "s" },
            { type: "text", text: "answer" },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    const res = await make("medium").chatCompletionNonStream(
      { model: MODEL, messages: [{ role: "user", content: "hi" }] } as any,
      new AbortController().signal,
    );
    expect(res.choices[0].message.content).toBe("answer");
  });
});
