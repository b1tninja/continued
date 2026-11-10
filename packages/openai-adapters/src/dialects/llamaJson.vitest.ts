import { describe, expect, it } from "vitest";
import {
  LlamaJsonRecovery,
  recoverLlamaJsonCalls,
  recoverLlamaJsonFromText,
  renderLlamaJsonCall,
} from "./llamaJson.js";
import { createTextToolRecovery, recoverFromText } from "./recovery.js";
import type { DialectTool, RecoveryEvent } from "./qwenXml.js";

const tools: DialectTool[] = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
      },
      required: ["command"],
    },
  },
];

// Replies of Llama 3.3 70B and Llama 4 Maverick on Bedrock Converse,
// 2026-11-10 (core/llm/toolDialects/corpus/fixtures).
const single =
  '{"type": "function", "name": "read_file", "parameters": {"path": "src/main.ts"}}';
const asStrings =
  '["{\\"type\\": \\"function\\", \\"name\\": \\"run_command\\", \\"parameters\\": {\\"command\\": \\"ls -la\\"}}", "{\\"type\\": \\"function\\", \\"name\\": \\"read_file\\", \\"parameters\\": {\\"path\\": \\"README.md\\"}}"]';
const wrapped =
  '["{\\"type\\": \\"function\\", \\"name\\": \\"run_command\\", \\"parameters\\": {\\"command\\": {\\"type\\": \\"string\\", \\"value\\": \\"git status\\"}}}"]';
const intAsString =
  '{"type": "function", "name": "run_command", "parameters": {"command": "grep -r TODO src", "timeout": "10"}}';

const env = { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "llama-json" };

function shown(events: RecoveryEvent[]) {
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}

describe("llama-json recovery", () => {
  it("recovers a single call object", () => {
    expect(recoverLlamaJsonCalls(single, tools)).toEqual([
      expect.objectContaining({
        name: "read_file",
        arguments: { path: "src/main.ts" },
      }),
    ]);
  });

  it("recovers an array of JSON-encoded strings, in order", () => {
    const calls = recoverLlamaJsonCalls(asStrings, tools);
    expect(calls?.map((c) => [c.name, c.arguments])).toEqual([
      ["run_command", { command: "ls -la" }],
      ["read_file", { path: "README.md" }],
    ]);
  });

  it("recovers an array of objects and a call without type", () => {
    const text = `[${single}, {"name": "run_command", "parameters": {"command": "pwd", "timeout": 5}}]`;
    expect(recoverLlamaJsonCalls(text, tools)?.length).toBe(2);
  });

  it("round-trips a rendered call", () => {
    const call = {
      name: "run_command",
      arguments: { command: "a\nb", timeout: 3 },
    };
    expect(
      recoverLlamaJsonCalls(renderLlamaJsonCall(call), tools)?.[0],
    ).toMatchObject(call);
  });

  it.each([
    ["prose before", `Sure. ${single}`],
    ["prose after", `${single}\nDone.`],
    ["a code fence", "```json\n" + single + "\n```"],
    ["two objects, no array", `${single}\n${single}`],
    ["an unknown tool", single.replace("read_file", "delete_all")],
    ["an undeclared argument", single.replace('"path"', '"file"')],
    ["a missing required argument", '{"name": "read_file", "parameters": {}}'],
    ["a number sent as a string", intAsString],
    ["schema-wrapped values (Llama 4 Maverick)", wrapped],
    ["an extra key", single.replace('"type"', '"id": 1, "type"')],
    ["type other than function", single.replace('"function"', '"tool"')],
    [
      "arguments instead of parameters",
      single.replace("parameters", "arguments"),
    ],
    ["no parameters object", '{"name": "read_file"}'],
    ["a bare string in an array", '["read_file"]'],
    ["an empty array", "[]"],
    [
      "an array with one bad element",
      `[${single}, {"name": "nope", "parameters": {}}]`,
    ],
    ["truncated JSON", single.slice(0, -3)],
    ["ordinary JSON", '{"port": 8080}'],
  ])("leaves %s as text", (_what, text) => {
    expect(recoverLlamaJsonCalls(text, tools)).toBeUndefined();
    expect(recoverLlamaJsonFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("gives the same answer for every chunking", () => {
    for (const text of [single, asStrings, wrapped, `  \n${single}\n`]) {
      const whole = recoverLlamaJsonFromText(text, tools);
      for (const size of [1, 2, 7]) {
        const r = new LlamaJsonRecovery(tools);
        const events: RecoveryEvent[] = [];
        for (let i = 0; i < text.length; i += size) {
          events.push(...r.push(text.slice(i, i + size)));
        }
        events.push(...r.end());
        expect(shown(events)).toEqual(whole);
      }
    }
  });

  it("releases a reply that does not start with JSON as it streams", () => {
    const r = new LlamaJsonRecovery(tools);
    expect(r.push("  ")).toEqual([]);
    expect(r.push("Hello {")).toEqual([{ type: "text", text: "  Hello {" }]);
    expect(r.push(" more")).toEqual([{ type: "text", text: " more" }]);
    expect(r.end()).toEqual([]);
  });

  it("is off without the setting and applies only to llama models", () => {
    const model = "us.meta.llama3-3-70b-instruct-v1:0";
    expect(createTextToolRecovery(model, tools, {}, {})).toBeUndefined();
    expect(recoverFromText(model, single, tools, {}, {}).calls).toEqual([]);
    expect(createTextToolRecovery(model, tools, {}, env)).toBeDefined();
    expect(recoverFromText(model, single, tools, {}, env).calls.length).toBe(1);
    expect(
      recoverFromText("us.amazon.nova-pro-v1:0", single, tools, {}, env).calls,
    ).toEqual([]);
    expect(
      recoverFromText(
        model,
        single,
        tools,
        { x_continue_recover_text_tool_calls: "llama-json" },
        {},
      ).calls.length,
    ).toBe(1);
  });
});
