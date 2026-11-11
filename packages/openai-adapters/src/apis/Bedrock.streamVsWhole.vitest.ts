import { describe, expect, it } from "vitest";
import { BedrockApi } from "./Bedrock.js";

/**
 * The same reply through the streaming path and through the whole-message
 * path must give the same tool call and the same visible text, for every
 * recovery dialect. Nova writes <thinking> tags into its text, which both
 * paths must lift out before recovery looks at what is left.
 */
const THINKING = "<thinking>The user wants a.txt read.</thinking>\n\n";
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

const tools = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: { filepath: { type: "string" } },
        required: ["filepath"],
      },
    },
  },
];

// Bedrock remembers, per model id, that a model refused streaming with tools,
// so every run gets an id of its own.
let runs = 0;

async function run(dialect: string, reply: string, size: number | "whole") {
  class Api extends BedrockApi {
    protected async credentialChain() {
      return { accessKeyId: "k", secretAccessKey: "s" };
    }
    async getClient() {
      return {
        send: async (command: { constructor: { name: string } }) => {
          if (size === "whole") {
            if (command.constructor.name === "ConverseStreamCommand") {
              throw new Error(
                "This model doesn't support tool use in streaming mode.",
              );
            }
            return {
              $metadata: { requestId: "r" },
              output: {
                message: { role: "assistant", content: [{ text: reply }] },
              },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            $metadata: { requestId: "r" },
            stream: (async function* () {
              const re = new RegExp(`[^]{1,${size}}`, "g");
              for (const t of reply.match(re) ?? []) {
                yield { contentBlockDelta: { delta: { text: t } } };
              }
              yield { contentBlockStop: {} };
              yield { messageStop: { stopReason: "end_turn" } };
            })(),
          };
        },
      } as any;
    }
  }
  const api = new Api({ provider: "bedrock", env: {} } as any);
  let visible = "";
  let reasoning = "";
  const calls: Record<number, { name: string; args: string }> = {};
  for await (const c of api.chatCompletionStream(
    {
      model: `us.amazon.nova-pro-v1:0-run${++runs}`,
      messages: [{ role: "user", content: "read a.txt" }],
      tools,
      stream: true,
      x_continue_recover_text_tool_calls: `force:${dialect}`,
    } as any,
    new AbortController().signal,
  )) {
    const delta: any = c.choices[0]?.delta;
    if (!delta) continue;
    visible += delta.content ?? "";
    reasoning += delta.reasoning_content ?? "";
    for (const t of delta.tool_calls ?? []) {
      const at = (calls[t.index] ??= { name: "", args: "" });
      at.name += t.function?.name ?? "";
      at.args += t.function?.arguments ?? "";
    }
  }
  return {
    visible,
    reasoning,
    calls: Object.values(calls).map((c) => ({
      name: c.name,
      args: JSON.parse(c.args),
    })),
  };
}

describe("BedrockApi: a reply streamed or whole gives the same result", () => {
  for (const [dialect, call] of Object.entries(CALLS)) {
    for (const size of [1, 5, 1000]) {
      it(`${dialect}: thinking then a call, chunks of ${size}`, async () => {
        const reply = THINKING + call;
        const whole = await run(dialect, reply, "whole");
        const streamed = await run(dialect, reply, size);
        expect(whole.calls).toEqual([
          { name: "Read", args: { filepath: "a.txt" } },
        ]);
        expect(whole.visible).toBe("");
        expect(whole.reasoning).toContain("a.txt read");
        expect(streamed).toEqual(whole);
      });
    }

    it(`${dialect}: thinking then prose gives the same text`, async () => {
      const reply = THINKING + "All done, nothing to read.";
      const whole = await run(dialect, reply, "whole");
      const streamed = await run(dialect, reply, 4);
      expect(whole.visible).toBe("All done, nothing to read.");
      expect(streamed).toEqual(whole);
    });
  }
});
