import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BedrockRuntimeClient: vi.fn().mockImplementation(function () {
    return { send, middlewareStack: { add: vi.fn() } };
  }),
  ConverseStreamCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
  ConverseCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
}));

import Bedrock from "./Bedrock";

/**
 * The same reply through the streaming path and through the whole-message
 * path must give the same tool call and the same visible text, for every
 * recovery dialect. A Nova model is used because it writes <thinking> tags
 * into its text, which both paths must lift out before recovery looks at
 * what is left (plans/tool-dialects.md: one implementation for both paths).
 */
const MODEL = "us.amazon.nova-pro-v1:0";
// Bedrock remembers, per model id, that a model refused streaming with tools,
// so every run gets an id of its own.
let runs = 0;
const THINKING = "<thinking>The user wants a.txt read.</thinking>\n\n";

const readTool = {
  type: "function" as const,
  displayTitle: "Read",
  wouldLikeTo: "read",
  isCurrently: "reading",
  hasAlready: "read",
  readonly: true,
  group: "t",
  function: {
    name: "Read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"],
    },
  },
};

const CALLS: Record<string, string> = {
  "qwen-xml":
    "<function=Read>\n<parameter=filepath>\na.txt\n</parameter>\n</function>",
  pythonic: 'Read(filepath="a.txt")',
  "llama-json": '{"name": "Read", "parameters": {"filepath": "a.txt"}}',
  "hermes-json":
    '<tool_call>{"name": "Read", "arguments": {"filepath": "a.txt"}}</tool_call>',
  "glm-xml":
    "<tool_call>Read<arg_key>filepath</arg_key><arg_value>a.txt</arg_value></tool_call>",
  harmony:
    '<|channel|>commentary to=functions.Read <|constrain|>json<|message|>{"filepath": "a.txt"}<|call|>',
  mistral: '[TOOL_CALLS]Read[ARGS]{"filepath": "a.txt"}',
  dsml: '<｜DSML｜function_calls>\n<｜DSML｜invoke name="Read">\n<｜DSML｜parameter name="filepath" string="true">a.txt</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>',
  "deepseek-v31":
    '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>Read<｜tool▁sep｜>{"filepath": "a.txt"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
};

const refusedStreaming = () =>
  Object.assign(
    new Error("This model doesn't support tool use in streaming mode."),
    { name: "ValidationException" },
  );

async function run(send1: () => void) {
  send1();
  const llm = new Bedrock({
    apiKey: "k",
    model: `${MODEL}-run${++runs}`,
    region: "us-east-1",
    capabilities: { tools: true },
  } as any);
  const out: any[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "read a.txt" }],
    new AbortController().signal,
    { tools: [readTool] } as any,
  )) {
    out.push(m);
  }
  const join = (role: string) =>
    out
      .filter((m) => m.role === role)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("");
  return {
    visible: join("assistant"),
    thinking: join("thinking"),
    calls: out
      .flatMap((m) => m.toolCalls ?? [])
      .map((c: any) => ({
        name: c.function.name,
        args: JSON.parse(c.function.arguments),
      })),
  };
}

const streamed = (reply: string, size: number) => () =>
  send.mockResolvedValueOnce({
    $metadata: { requestId: "r" },
    stream: (async function* () {
      for (const t of reply.match(new RegExp(`[^]{1,${size}}`, "g")) ?? []) {
        yield { contentBlockDelta: { delta: { text: t } } };
      }
      yield { contentBlockStop: {} };
      yield { messageStop: { stopReason: "end_turn" } };
    })(),
  });

const whole = (reply: string) => () =>
  send.mockRejectedValueOnce(refusedStreaming()).mockResolvedValueOnce({
    $metadata: { requestId: "r" },
    output: { message: { role: "assistant", content: [{ text: reply }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });

describe("Bedrock: a reply streamed or whole gives the same result", () => {
  const saved = process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  beforeEach(() => {
    send.mockReset();
  });
  afterEach(() => {
    if (saved === undefined)
      delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    else process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = saved;
  });

  for (const [dialect, call] of Object.entries(CALLS)) {
    for (const size of [1, 5, 1000]) {
      it(`${dialect}: thinking then a call, chunks of ${size}`, async () => {
        process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = `force:${dialect}`;
        const reply = THINKING + call;
        const w = await run(whole(reply));
        const s = await run(streamed(reply, size));
        expect(w.calls).toEqual([
          { name: "Read", args: { filepath: "a.txt" } },
        ]);
        expect(w.visible).toBe("");
        expect(w.thinking).toContain("a.txt read");
        expect(s).toEqual(w);
      });
    }

    it(`${dialect}: thinking then prose gives the same text`, async () => {
      process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = `force:${dialect}`;
      const reply = THINKING + "All done, nothing to read.";
      const w = await run(whole(reply));
      const s = await run(streamed(reply, 4));
      expect(w.visible).toBe("All done, nothing to read.");
      expect(s).toEqual(w);
    });
  }
});
