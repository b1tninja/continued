import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requests: { path: string; body: any }[] = [];
const call = "<function=Read>\n<parameter=p>\nx\n</parameter>\n</function>";

vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchwithRequestOptions: (url: URL, init: any) => {
    requests.push({
      path: new URL(url).pathname,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const events = [
      { content: call.slice(0, 12) },
      { content: call.slice(12) },
    ].map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
    events.push({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    } as never);
    return new Response(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  },
}));

import OpenAI from "./OpenAI";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "Read",
      parameters: {
        type: "object",
        properties: { p: { type: "string" } },
        required: ["p"],
      },
    },
  },
];

let n = 0;
async function reply(toolDialect?: "qwen-xml" | "off") {
  const llm = new OpenAI({
    model: "qwen3-coder",
    apiBase: `http://127.0.0.1:${9500 + n++}/v1/`,
    apiKey: "k",
    toolDialect,
  } as never);
  const messages: any[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "read x" }],
    new AbortController().signal,
    { tools } as never,
  )) {
    messages.push(m);
  }
  return messages;
}

describe("OpenAI-compatible text tool-call recovery in the IDE chat path", () => {
  beforeEach(() => {
    requests.length = 0;
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  });
  afterEach(() => {
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  });

  it("is off by default: the call stays text", async () => {
    const messages = await reply();
    expect(messages.some((m) => m.toolCalls?.length)).toBe(false);
    expect(messages.map((m) => m.content).join("")).toBe(call);
  });

  it("toolDialect qwen-xml turns the text into a call, and the switch is not sent", async () => {
    const messages = await reply("qwen-xml");
    const calls = messages.flatMap((m) => m.toolCalls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("Read");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ p: "x" });
    const sent = requests.find((r) => r.path.endsWith("/chat/completions"));
    expect(sent?.body).not.toHaveProperty("x_continue_recover_text_tool_calls");
  });

  it("toolDialect off keeps it text even with the model name matching", async () => {
    const messages = await reply("off");
    expect(messages.some((m) => m.toolCalls?.length)).toBe(false);
  });

  it("the environment variable wins over toolDialect off", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "qwen-xml";
    const messages = await reply("off");
    expect(messages.some((m) => m.toolCalls?.length)).toBe(true);
  });
});
