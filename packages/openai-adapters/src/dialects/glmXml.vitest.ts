import { describe, expect, it } from "vitest";
import {
  GlmXmlRecovery,
  recoverGlmXmlFromText,
  renderGlmXmlCall,
} from "./glmXml.js";

const tools = [
  {
    name: "set_todos",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        todos: { type: "array" },
        count: { type: "integer" },
      },
      required: ["title"],
    },
  },
];
const args = { title: "x", todos: ["a"], count: 2 };

describe("glm-xml recovery", () => {
  it("round-trips a call with typed values", () => {
    const r = recoverGlmXmlFromText(
      renderGlmXmlCall({ name: "set_todos", arguments: args }),
      tools,
    );
    expect(r.calls.map((c) => c.arguments)).toEqual([args]);
    expect(r.text).toBe("");
  });

  it("keeps a string value verbatim, even when it looks like JSON", () => {
    const r = recoverGlmXmlFromText(
      renderGlmXmlCall({ name: "set_todos", arguments: { title: "123" } }),
      tools,
    );
    expect(r.calls[0].arguments).toEqual({ title: "123" });
  });

  it.each([
    [
      "prose before",
      "ok <tool_call>set_todos<arg_key>title</arg_key><arg_value>a</arg_value></tool_call>",
    ],
    [
      "unknown tool",
      "<tool_call>rm<arg_key>title</arg_key><arg_value>a</arg_value></tool_call>",
    ],
    [
      "bad JSON for an integer",
      "<tool_call>set_todos<arg_key>title</arg_key><arg_value>a</arg_value><arg_key>count</arg_key><arg_value>two</arg_value></tool_call>",
    ],
    [
      "duplicate key",
      "<tool_call>set_todos<arg_key>title</arg_key><arg_value>a</arg_value><arg_key>title</arg_key><arg_value>b</arg_value></tool_call>",
    ],
    [
      "missing required",
      "<tool_call>set_todos<arg_key>count</arg_key><arg_value>1</arg_value></tool_call>",
    ],
    [
      "unclosed",
      "<tool_call>set_todos<arg_key>title</arg_key><arg_value>a</arg_value>",
    ],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverGlmXmlFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("does not hold a reply that does not start like a call", () => {
    const r = new GlmXmlRecovery(tools);
    expect(r.push("Done.")).toEqual([{ type: "text", text: "Done." }]);
  });
});
