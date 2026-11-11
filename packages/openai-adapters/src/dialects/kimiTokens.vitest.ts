import { describe, expect, it } from "vitest";
import {
  KimiTokensRecovery,
  recoverKimiTokensFromText,
  renderKimiTokensCalls,
} from "./kimiTokens.js";

const tools = [
  {
    name: "search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        tags: { type: "array" },
      },
      required: ["query"],
    },
  },
  { name: "get_time", parameters: { type: "object", properties: {} } },
];
const section = (id: string, args: string) =>
  `<|tool_calls_section_begin|><|tool_call_begin|>${id}<|tool_call_argument_begin|>${args}<|tool_call_end|><|tool_calls_section_end|>`;

describe("kimi-tokens recovery", () => {
  it("round-trips two calls with typed values", () => {
    const calls = [
      { name: "search", arguments: { query: "q", limit: 3, tags: ["a"] } },
      { name: "get_time", arguments: {} },
    ];
    const r = recoverKimiTokensFromText(renderKimiTokensCalls(calls), tools);
    expect(r.calls.map((c) => c.arguments)).toEqual(
      calls.map((c) => c.arguments),
    );
    expect(r.text).toBe("");
  });

  it("keeps a leading think block as text and accepts any id index", () => {
    const text = `<think>hm</think>\n${section("functions.search:7", '{"query": "x"}')}`;
    const r = recoverKimiTokensFromText(text, tools);
    expect(r.text).toBe("<think>hm</think>\n");
    expect(r.calls[0].arguments).toEqual({ query: "x" });
  });

  it("tolerates whitespace around the id and the arguments, as the vendor regex does", () => {
    const text = `<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.search:0 <|tool_call_argument_begin|>\n{"query": "x"}\n<|tool_call_end|>\n<|tool_calls_section_end|>`;
    expect(recoverKimiTokensFromText(text, tools).calls).toHaveLength(1);
  });

  it.each([
    ["prose before", `ok ${section("functions.search:0", '{"query":"x"}')}`],
    ["prose after", `${section("functions.search:0", '{"query":"x"}')} ok`],
    ["id without a name", section("call_123", '{"query":"x"}')],
    ["unknown tool", section("functions.rm:0", '{"query":"x"}')],
    ["unquoted JSON", section("functions.search:0", "{query: 1}")],
    ["array arguments", section("functions.search:0", '["x"]')],
    [
      "undeclared argument",
      section("functions.search:0", '{"query":"x","z":1}'),
    ],
    ["missing required", section("functions.search:0", "{}")],
    [
      "wrong type",
      section("functions.search:0", '{"query":"x","limit":"two"}'),
    ],
    [
      "duplicate id",
      `<|tool_calls_section_begin|><|tool_call_begin|>functions.get_time:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_call_begin|>functions.get_time:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>`,
    ],
    [
      "unclosed section",
      section("functions.search:0", '{"query":"x"}').replace(
        "<|tool_calls_section_end|>",
        "",
      ),
    ],
    ["empty section", "<|tool_calls_section_begin|><|tool_calls_section_end|>"],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverKimiTokensFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("does not hold a reply that does not start like a call", () => {
    const r = new KimiTokensRecovery(tools);
    expect(r.push("Done.")).toEqual([{ type: "text", text: "Done." }]);
  });
});
