import { describe, expect, it } from "vitest";
import { recoverGlmXmlFromText } from "./glmXml.js";
import { recoverDeepseekR1FromText } from "./deepseekR1.js";
import { recoverDeepseekV31FromText } from "./deepseekV31.js";
import { recoverDsmlFromText } from "./dsml.js";
import { recoverHarmonyFromText } from "./harmony.js";
import { recoverMistralFromText } from "./mistral.js";
import { recoverHermesJsonFromText } from "./hermesJson.js";
import { recoverKimiTokensFromText } from "./kimiTokens.js";
import { recoverKimiXtmlFromText } from "./kimiXtml.js";
import { recoverLlamaJsonFromText } from "./llamaJson.js";
import { recoverMinimaxNsFromText } from "./minimaxNs.js";
import { recoverMinimaxXmlFromText } from "./minimaxXml.js";
import { recoverPythonicFromText } from "./pythonic.js";
import { type DialectTool, recoverQwenXmlFromText } from "./qwenXml.js";
import { coerceString, coerceToSchema } from "./schemaCheck.js";
import { recoverToolcallJsonFromText } from "./toolcallJson.js";

describe("coerceString", () => {
  it.each([
    ["10", "integer", 10],
    ["-3", "integer", -3],
    ["0", "integer", 0],
    ["10", "number", 10],
    ["0.5", "number", 0.5],
    ["true", "boolean", true],
    ["false", "boolean", false],
    ["[1,2]", "array", [1, 2]],
    ['{"a":1}', "object", { a: 1 }],
  ])("reads %j as the %s %j", (text, type, value) => {
    expect(coerceString(text, type)).toEqual(value);
  });

  it.each([
    ["10abc", "integer"],
    ["1e3", "integer"],
    ["1e3", "number"],
    ["1.0", "integer"],
    ["1.5", "integer"],
    ["010", "integer"],
    ["+1", "integer"],
    ["-0", "integer"],
    [" 10", "integer"],
    ["", "integer"],
    ["", "boolean"],
    ["", "array"],
    ["True", "boolean"],
    ["yes", "boolean"],
    ["1", "boolean"],
    ["9007199254740993", "integer"],
    ["NaN", "number"],
    ["Infinity", "number"],
    ["[1,2]", "object"],
    ['{"a":1}', "array"],
    ["[1,", "array"],
    ["null", "object"],
  ])("refuses %j for %s", (text, type) => {
    expect(coerceString(text, type)).toBeUndefined();
  });

  it("never touches a parameter that may be a string, or declares no type", () => {
    expect(coerceString("10", "string")).toBeUndefined();
    expect(coerceString("10", ["string", "integer"])).toBeUndefined();
    expect(coerceString("10", undefined)).toBeUndefined();
    expect(coerceString("true", "string")).toBeUndefined();
  });

  it("takes any of a list of types", () => {
    expect(coerceString("10", ["integer", "null"])).toBe(10);
  });
});

describe("coerceToSchema", () => {
  it("returns a value that already fits unchanged and unrepaired", () => {
    expect(coerceToSchema(10, "integer")).toEqual({
      value: 10,
      repaired: false,
    });
    expect(coerceToSchema("10", "string")).toEqual({
      value: "10",
      repaired: false,
    });
  });

  it("flags a string that was made into its literal", () => {
    expect(coerceToSchema("10", "integer")).toEqual({
      value: 10,
      repaired: true,
    });
  });

  it("refuses a non-string that does not fit, and a string that is no literal", () => {
    expect(coerceToSchema(10, "string")).toBeUndefined();
    expect(coerceToSchema(1.5, "integer")).toBeUndefined();
    expect(coerceToSchema("10abc", "integer")).toBeUndefined();
  });
});

const tools: DialectTool[] = [
  {
    name: "run_command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
        background: { type: "boolean" },
        paths: { type: "array" },
      },
      required: ["command"],
    },
  },
];

/** The same call, with its timeout written as a string, in every dialect. */
const dialects: [string, (timeout: string) => string, (t: string) => any][] = [
  [
    "qwen-xml",
    (t) =>
      `<function=run_command>\n<parameter=command>\n10\n</parameter>\n<parameter=timeout>\n${t}\n</parameter>\n</function>`,
    (t) => recoverQwenXmlFromText(t, tools),
  ],
  [
    "pythonic",
    (t) => `run_command(command="10", timeout="${t}")`,
    (t) => recoverPythonicFromText(t, tools),
  ],
  [
    "llama-json",
    (t) =>
      `{"name": "run_command", "parameters": {"command": "10", "timeout": "${t}"}}`,
    (t) => recoverLlamaJsonFromText(t, tools),
  ],
  [
    "hermes-json",
    (t) =>
      `<tool_call>{"name": "run_command", "arguments": {"command": "10", "timeout": "${t}"}}</tool_call>`,
    (t) => recoverHermesJsonFromText(t, tools),
  ],
  [
    "glm-xml",
    (t) =>
      `<tool_call>run_command<arg_key>command</arg_key><arg_value>10</arg_value><arg_key>timeout</arg_key><arg_value>${t}</arg_value></tool_call>`,
    (t) => recoverGlmXmlFromText(t, tools),
  ],
  [
    "harmony",
    (t) =>
      `<|channel|>commentary to=functions.run_command <|constrain|>json<|message|>{"command": "10", "timeout": "${t}"}<|call|>`,
    (t) => recoverHarmonyFromText(t, tools),
  ],
  [
    "mistral",
    (t) => `[TOOL_CALLS]run_command[ARGS]{"command": "10", "timeout": "${t}"}`,
    (t) => recoverMistralFromText(t, tools),
  ],
  [
    "dsml",
    (t) =>
      `<｜DSML｜function_calls>
<｜DSML｜invoke name="run_command">
<｜DSML｜parameter name="command" string="true">10</｜DSML｜parameter>
<｜DSML｜parameter name="timeout" string="true">${t}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`,
    (t) => recoverDsmlFromText(t, tools),
  ],
  [
    "deepseek-v31",
    (t) =>
      `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>run_command<｜tool▁sep｜>{"command": "10", "timeout": "${t}"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
    (t) => recoverDeepseekV31FromText(t, tools),
  ],
  [
    "deepseek-r1",
    (t) =>
      `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>run_command
\`\`\`json
{"command": "10", "timeout": "${t}"}
\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
    (t) => recoverDeepseekR1FromText(t, tools),
  ],
  [
    "kimi-tokens",
    (t) =>
      `<|tool_calls_section_begin|><|tool_call_begin|>functions.run_command:0<|tool_call_argument_begin|>{"command": "10", "timeout": "${t}"}<|tool_call_end|><|tool_calls_section_end|>`,
    (t) => recoverKimiTokensFromText(t, tools),
  ],
  [
    "kimi-xtml",
    (t) =>
      `<|open|>tools<|sep|><|open|>call tool="run_command" index="1"<|sep|><|open|>argument key="command" type="string"<|sep|>10<|close|>argument<|sep|><|open|>argument key="timeout" type="string"<|sep|>${t}<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>`,
    (t) => recoverKimiXtmlFromText(t, tools),
  ],
  [
    "minimax-xml",
    (t) =>
      `<minimax:tool_call>
<invoke name="run_command">
<parameter name="command">10</parameter>
<parameter name="timeout">${t}</parameter>
</invoke>
</minimax:tool_call>`,
    (t) => recoverMinimaxXmlFromText(t, tools),
  ],
  [
    "minimax-ns-xml",
    (t) =>
      `]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="run_command">]<]minimax[>[<command>10]<]minimax[>[</command>]<]minimax[>[<timeout>${t}]<]minimax[>[</timeout>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>`,
    (t) => recoverMinimaxNsFromText(t, tools),
  ],
  [
    "toolcall-json",
    (t) =>
      `<TOOLCALL>[{"name": "run_command", "arguments": {"command": "10", "timeout": "${t}"}}]</TOOLCALL>`,
    (t) => recoverToolcallJsonFromText(t, tools),
  ],
];

/**
 * GLM writes every value as text and reads a non-string one as JSON of the
 * declared type, which is its own encoding rather than a repair: `10` is the
 * integer with no note, and `1e3` is JSON for 1000.
 */
const glmReadsJson = (name: string) =>
  name === "glm-xml" || name === "minimax-xml" || name === "minimax-ns-xml";
/** The ones that parse a value as JSON, so `1e3` is the number 1000. */
const readsExponent = (name: string) =>
  name === "glm-xml" || name === "minimax-xml";

describe.each(dialects)(
  "%s: a number written as a string",
  (name, render, run) => {
    it("is made into the integer, the string parameter keeps its digits, and the call says so", () => {
      const out = run(render("10"));
      expect(out.text).toBe("");
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0].arguments).toEqual({ command: "10", timeout: 10 });
      if (glmReadsJson(name)) {
        expect(out.calls[0].repairs).toBeUndefined();
        return;
      }
      expect(out.calls[0].repairs).toEqual([
        { kind: "string-to-literal", argument: "timeout", from: "10", to: 10 },
      ]);
    });

    it.each(["10abc", "", "ten", ...(readsExponent(name) ? [] : ["1e3"])])(
      "leaves a call whose integer is %j as text",
      (bad) => {
        const text = render(bad);
        expect(run(text)).toEqual({ text, calls: [] });
      },
    );
  },
);

describe("a call that needed no repair", () => {
  it("carries no repairs field", () => {
    const out = recoverLlamaJsonFromText(
      '{"name": "run_command", "parameters": {"command": "ls", "timeout": 10}}',
      tools,
    );
    expect(out.calls).toHaveLength(1);
    expect("repairs" in out.calls[0]).toBe(false);
  });
});
