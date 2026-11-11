import { describe, expect, it } from "vitest";
import { createTextToolRecovery, recoverFromText } from "./recovery.js";

/**
 * Owner rule (Q28): the whole reply must be calls, with an optional leading
 * think block. Prose before or after the calls leaves the reply as text, for
 * every dialect, whole-reply and streamed alike.
 */
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
  harmony:
    '<|channel|>commentary to=functions.Read <|constrain|>json<|message|>{"filepath": "a.txt"}<|call|>',
  mistral: '[TOOL_CALLS]Read[ARGS]{"filepath": "a.txt"}',
  dsml: '<｜DSML｜function_calls>\n<｜DSML｜invoke name="Read">\n<｜DSML｜parameter name="filepath" string="true">a.txt</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>',
  "deepseek-v31":
    '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>Read<｜tool▁sep｜>{"filepath": "a.txt"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  "deepseek-r1":
    '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Read\n```json\n{"filepath": "a.txt"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  "toolcall-json":
    '<TOOLCALL>[{"name": "Read", "arguments": {"filepath": "a.txt"}}]</TOOLCALL>',
};

const TOOLS = [
  {
    name: "Read",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"],
    },
  },
];

const THINK = "<think>I should read it.</think>\n";

function stream(dialect: string, reply: string, size: number) {
  const stage = createTextToolRecovery("m", TOOLS, {
    x_continue_recover_text_tool_calls: `force:${dialect}`,
  })!;
  const events = [];
  for (let i = 0; i < reply.length; i += size) {
    events.push(...stage.push(reply.slice(i, i + size)));
  }
  events.push(...stage.end());
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.filter((e) => e.type === "call").length,
  };
}

/** Dialects whose parser does not take a leading `<think>` block today. */
const NO_THINK_LEAD = new Set([
  "llama-json",
  "kimi-xtml",
  "minimax-ns-xml",
  "harmony",
]);

const SIZES = [1, 7, 10_000];

describe("the whole reply must be calls (whole and streamed)", () => {
  for (const [dialect, call] of Object.entries(CALLS)) {
    const cases: [string, string][] = [
      ["prose before the call", `I will read it now.\n${call}`],
      ["prose after the call", `${call}\nThat reads the file.`],
      ["prose on both sides", `First.\n${call}\nThen.`],
      ["think, prose, call", `${THINK}I will read it.\n${call}`],
      ["call, prose, call", `${call}\nand also\n${call}`],
    ];
    for (const [label, reply] of cases) {
      it(`${dialect}: ${label} stays text`, () => {
        const whole = recoverFromText("m", reply, TOOLS, {
          x_continue_recover_text_tool_calls: `force:${dialect}`,
        });
        expect(whole.calls).toEqual([]);
        expect(whole.text).toBe(reply);
        for (const size of SIZES) {
          const s = stream(dialect, reply, size);
          expect(s.calls, `size ${size}`).toBe(0);
          expect(s.text, `size ${size}`).toBe(reply);
        }
      });
    }

    it(`${dialect}: a call alone, or after a think block, is recovered`, () => {
      const replies = [call, `\n${call}\n`];
      if (!NO_THINK_LEAD.has(dialect)) replies.push(`${THINK}${call}`);
      for (const reply of replies) {
        for (const size of SIZES) {
          expect(stream(dialect, reply, size).calls, `${size}`).toBe(1);
        }
      }
    });
  }
});
