import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIApi } from "./OpenAI.js";

const call = "<function=Read>\n<parameter=p>\nx\n</parameter>\n</function>";
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

function chunk(delta: object, finish: string | null = null) {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "qwen3-coder",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function* replies() {
  yield chunk({ content: call.slice(0, 11) });
  yield chunk({ content: call.slice(11) });
  yield chunk({}, "stop");
}

function api(requestOptions?: object) {
  const a = new OpenAIApi({
    provider: "openai",
    apiKey: "k",
    apiBase: "http://localhost:1234/v1/",
    requestOptions,
  } as never);
  const create = vi.fn().mockImplementation(async () => replies());
  (a as any).openai = { chat: { completions: { create } } };
  return { a, create };
}

async function collect(a: OpenAIApi, extra: object = {}) {
  const out: any[] = [];
  for await (const c of a.chatCompletionStream(
    {
      model: "qwen3-coder",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools,
      ...extra,
    } as never,
    new AbortController().signal,
  ))
    out.push(c);
  return out;
}

describe("OpenAIApi text tool-call recovery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off by default: the text passes through", async () => {
    const { a } = api();
    const out = await collect(a);
    expect(out.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(
      call,
    );
    expect(out.some((c) => c.choices[0].delta.tool_calls)).toBe(false);
  });

  it("recovers with the request field, and never sends the field", async () => {
    const { a, create } = api();
    const out = await collect(a, {
      x_continue_recover_text_tool_calls: "force:qwen-xml",
    });
    expect(
      out.flatMap((c) => c.choices[0].delta.tool_calls ?? []),
    ).toHaveLength(1);
    expect(out.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(create.mock.calls[0][0]).not.toHaveProperty(
      "x_continue_recover_text_tool_calls",
    );
  });

  it("recovers with the environment variable", async () => {
    vi.stubEnv("CONTINUE_RECOVER_TEXT_TOOL_CALLS", "qwen-xml");
    const { a } = api();
    const out = await collect(a);
    expect(
      out.flatMap((c) => c.choices[0].delta.tool_calls ?? []),
    ).toHaveLength(1);
  });

  it("recovers with the field from extraBodyProperties", async () => {
    const { a } = api({
      extraBodyProperties: {
        x_continue_recover_text_tool_calls: "force:qwen-xml",
      },
    });
    const out = await collect(a);
    expect(out.some((c) => c.choices[0].delta.tool_calls)).toBe(true);
  });

  it("does nothing without tools", async () => {
    const { a } = api();
    const out = await collect(a, {
      tools: undefined,
      x_continue_recover_text_tool_calls: "force:qwen-xml",
    });
    expect(out.some((c) => c.choices[0].delta.tool_calls)).toBe(false);
  });
});
