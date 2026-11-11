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
  "kimi-tokens":
    '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"filepath": "a.txt"}<|tool_call_end|><|tool_calls_section_end|>',
  "kimi-xtml":
    '<|open|>tools<|sep|><|open|>call tool="Read" index="1"<|sep|><|open|>argument key="filepath" type="string"<|sep|>a.txt<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>',
  "minimax-xml":
    '<minimax:tool_call>\n<invoke name="Read">\n<parameter name="filepath">a.txt</parameter>\n</invoke>\n</minimax:tool_call>',
  "minimax-ns-xml":
    ']<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name="Read">]<]minimax[>[<filepath>a.txt]<]minimax[>[</filepath>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>',
  "toolcall-json":
    '<TOOLCALL>[{"name": "Read", "arguments": {"filepath": "a.txt"}}]</TOOLCALL>',
  "granite-tokens":
    '<|tool_call|>[{"name": "Read", "arguments": {"filepath": "a.txt"}}]',
  "lfm-tokens": "<|tool_call_start|>[Read(filepath='a.txt')]<|tool_call_end|>",
  "hy3-tags":
    "<tool_calls:opensource><tool_call:opensource>Read<tool_sep:opensource><arg_key:opensource>filepath</arg_key:opensource><arg_value:opensource>a.txt</arg_value:opensource></tool_call:opensource></tool_calls:opensource>",
  "solar-tokens":
    '<|tool_calls|><|tool_call:begin|>a1b2c3d4e5<|tool_call:name|>Read<|tool_call:args|>{"filepath": "a.txt"}<|tool_call:end|><|calls|>',
  "longcat-json":
    '<longcat_tool_call>{"name": "Read", "arguments": {"filepath": "a.txt"}}</longcat_tool_call>',
  "olmo-function-calls":
    '<function_calls>Read(filepath="a.txt")</function_calls>',
  "seed-xml":
    "<seed:tool_call><function=Read><parameter=filepath>a.txt</parameter></function></seed:tool_call>",
  "cohere-action":
    '<|START_ACTION|>[{"tool_name": "Read", "parameters": {"filepath": "a.txt"}}]<|END_ACTION|>',
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

    for (const [label, reply] of [
      ["prose then a call", `Reading it now.\n${call}`],
      ["a call then prose", `${call}\nThat reads it.`],
    ]) {
      it(`${dialect}: ${label} stays text in both paths (the whole reply must be calls)`, async () => {
        process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = `force:${dialect}`;
        const w = await run(whole(reply));
        expect(w.calls).toEqual([]);
        expect(w.visible).toBe(reply);
        for (const size of [1, 7, 1000]) {
          send.mockReset();
          expect(await run(streamed(reply, size))).toEqual(w);
        }
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
