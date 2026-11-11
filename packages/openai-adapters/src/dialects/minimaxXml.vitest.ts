import { describe, expect, it } from "vitest";
import {
  MinimaxXmlRecovery,
  recoverMinimaxXmlFromText,
  renderMinimaxXmlCalls,
} from "./minimaxXml.js";

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
];
const block = (inner: string) =>
  `<minimax:tool_call>\n<invoke name="search">\n${inner}</invoke>\n</minimax:tool_call>`;
const param = (k: string, v: string) =>
  `<parameter name="${k}">${v}</parameter>\n`;

describe("minimax-xml recovery", () => {
  it("round-trips two invokes with typed values", () => {
    const calls = [
      { name: "search", arguments: { query: "q", limit: 3, tags: ["a"] } },
      { name: "search", arguments: { query: "123" } },
    ];
    const r = recoverMinimaxXmlFromText(renderMinimaxXmlCalls(calls), tools);
    expect(r.calls.map((c) => c.arguments)).toEqual(
      calls.map((c) => c.arguments),
    );
    expect(r.text).toBe("");
  });

  it("keeps a leading think block and accepts adjacent blocks", () => {
    const text = `<think>hm</think>\n\n${block(param("query", "a"))}\n${block(param("query", "b"))}`;
    const r = recoverMinimaxXmlFromText(text, tools);
    expect(r.text).toBe("<think>hm</think>\n\n");
    expect(r.calls.map((c) => c.arguments)).toEqual([
      { query: "a" },
      { query: "b" },
    ]);
  });

  it("keeps a literal </parameter> inside a value", () => {
    const r = recoverMinimaxXmlFromText(
      block(param("query", "a</parameter>b")),
      tools,
    );
    expect(r.calls[0].arguments).toEqual({ query: "a</parameter>b" });
  });

  it.each([
    ["prose before", `ok ${block(param("query", "a"))}`],
    ["prose after", `${block(param("query", "a"))} ok`],
    ["unknown tool", block(param("query", "a")).replace('"search"', '"rm"')],
    [
      "single-quoted name",
      block(param("query", "a")).replace('"search"', "'search'"),
    ],
    ["integer not JSON", block(param("query", "a") + param("limit", "two"))],
    ["undeclared argument", block(param("query", "a") + param("zzz", "1"))],
    ["duplicate key", block(param("query", "a") + param("query", "b"))],
    ["missing required", block("")],
    [
      "unclosed parameter",
      block(param("query", "a")).replace("</parameter>", ""),
    ],
    [
      "unclosed block",
      block(param("query", "a")).replace("</minimax:tool_call>", ""),
    ],
    ["empty block", "<minimax:tool_call>\n</minimax:tool_call>"],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverMinimaxXmlFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("does not hold a reply that does not start like a call", () => {
    const r = new MinimaxXmlRecovery(tools);
    expect(r.push("Done.")).toEqual([{ type: "text", text: "Done." }]);
  });
});
