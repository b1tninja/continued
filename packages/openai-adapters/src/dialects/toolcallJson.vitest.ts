import { describe, expect, it } from "vitest";
import { createTextToolRecovery } from "./recovery.js";
import { recoveryStatsSnapshot, resetRecoveryStats } from "./recoveryStats.js";
import {
  recoverToolcallJsonFromText,
  renderToolcallJsonCalls,
  ToolcallJsonRecovery,
} from "./toolcallJson.js";

const tools = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    },
  },
];
const call = { name: "read_file", arguments: { path: "a.ts", limit: 3 } };
const one = renderToolcallJsonCalls([call]);

describe("toolcall-json recovery", () => {
  it("recovers one call, an array of calls and several blocks", () => {
    const single = recoverToolcallJsonFromText(one, tools);
    expect(single.calls.map((c) => c.arguments)).toEqual([call.arguments]);
    expect(single.text).toBe("");
    const array = recoverToolcallJsonFromText(
      renderToolcallJsonCalls([call, { name: "list_dir", arguments: {} }]),
      tools,
    );
    expect(array.calls.map((c) => c.name)).toEqual(["read_file", "list_dir"]);
    const blocks = recoverToolcallJsonFromText(`${one}\n${one}`, tools);
    expect(blocks.calls).toHaveLength(2);
  });

  it("accepts whitespace inside and between, and a call's argument string holding JSON", () => {
    const r = recoverToolcallJsonFromText(
      '<TOOLCALL>\n[ {"name": "read_file", "arguments": "{\\"path\\": \\"a\\"}"} ]\n</TOOLCALL>',
      tools,
    );
    expect(r.calls.map((c) => c.arguments)).toEqual([{ path: "a" }]);
  });

  it("keeps a leading think block as text", () => {
    const r = recoverToolcallJsonFromText(`<think>x</think>\n${one}`, tools);
    expect(r.text).toBe("<think>x</think>\n");
    expect(r.calls).toHaveLength(1);
  });

  it("reads a close tag inside a string as part of the string", () => {
    const text = renderToolcallJsonCalls([
      { name: "read_file", arguments: { path: "</TOOLCALL>[" } },
    ]);
    expect(recoverToolcallJsonFromText(text, tools).calls[0].arguments).toEqual(
      { path: "</TOOLCALL>[" },
    );
  });

  it.each([
    ["prose before", `ok\n${one}`],
    ["prose after", `${one}\ndone`],
    [
      "a bare object (the vendor parser mends this wrongly)",
      `<TOOLCALL>${JSON.stringify(call)}</TOOLCALL>`,
    ],
    [
      "a call without arguments (the vendor parser drops it)",
      '<TOOLCALL>[{"name": "list_dir"}]</TOOLCALL>',
    ],
    [
      "a call with parameters instead of arguments",
      '<TOOLCALL>[{"name": "list_dir", "parameters": {}}]</TOOLCALL>',
    ],
    [
      "an extra key",
      '<TOOLCALL>[{"name": "list_dir", "arguments": {}, "id": "1"}]</TOOLCALL>',
    ],
    ["an empty array", "<TOOLCALL>[]</TOOLCALL>"],
    ["a non-object element", '<TOOLCALL>["list_dir"]</TOOLCALL>'],
    [
      "one bad call among good ones",
      renderToolcallJsonCalls([call, { name: "rm", arguments: {} }]),
    ],
    [
      "a second block that is bad",
      `${one}\n<TOOLCALL>[{"name":"list_dir"}]</TOOLCALL>`,
    ],
    ["unknown tool", renderToolcallJsonCalls([{ ...call, name: "rm" }])],
    [
      "undeclared argument",
      renderToolcallJsonCalls([{ ...call, arguments: { path: "a", x: 1 } }]),
    ],
    [
      "a string that is not an integer literal",
      renderToolcallJsonCalls([
        { ...call, arguments: { path: "a", limit: "3x" } },
      ]),
    ],
    [
      "missing required",
      renderToolcallJsonCalls([{ ...call, arguments: { limit: 1 } }]),
    ],
    ["lower-case tags", one.toLowerCase()],
    ["a fenced example", `\`\`\`\n${one}\n\`\`\``],
    ["truncated", one.slice(0, -14)],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverToolcallJsonFromText(text, tools)).toEqual({
      text,
      calls: [],
    });
  });

  it("releases a reply that cannot start a call without holding it", () => {
    const r = new ToolcallJsonRecovery(tools);
    expect(r.push("Hello")).toEqual([{ type: "text", text: "Hello" }]);
    expect(r.push(" there")).toEqual([{ type: "text", text: " there" }]);
    expect(r.end()).toEqual([]);
  });

  it("gives the same result for every chunking of a call", () => {
    for (let size = 1; size <= one.length; size += 3) {
      const r = new ToolcallJsonRecovery(tools);
      const events = [];
      for (let i = 0; i < one.length; i += size) {
        events.push(...r.push(one.slice(i, i + size)));
      }
      events.push(...r.end());
      expect(events.map((e) => e.type)).toEqual(["call"]);
    }
  });

  it("is chosen by toolDialect even for a model with an unrelated name, and by name for Nemotron", () => {
    const forced = createTextToolRecovery("x", tools, {
      x_continue_recover_text_tool_calls: "force:toolcall-json",
    });
    expect(forced).toBeDefined();
    expect(
      createTextToolRecovery("nvidia.nemotron-nano-9b-v2", tools, {
        x_continue_recover_text_tool_calls: "toolcall-json",
      }),
    ).toBeDefined();
    expect(
      createTextToolRecovery("qwen3", tools, {
        x_continue_recover_text_tool_calls: "toolcall-json",
      }),
    ).toBeUndefined();
  });

  it("reports a refused call: the held reply is counted as released as text", () => {
    resetRecoveryStats();
    const stage = createTextToolRecovery("nemo", tools, {
      x_continue_recover_text_tool_calls: "force:toolcall-json",
    })!;
    const bad = '<TOOLCALL>[{"name": "list_dir"}]</TOOLCALL>';
    const events = [...stage.push(bad), ...stage.end()];
    expect(events).toEqual([{ type: "text", text: bad }]);
    expect(recoveryStatsSnapshot()).toEqual([
      {
        model: "nemo",
        dialect: "toolcall-json",
        held: 1,
        recovered: 0,
        releasedAsText: 1,
      },
    ]);
  });
});
