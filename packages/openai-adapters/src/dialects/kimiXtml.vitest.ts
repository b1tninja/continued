import { describe, expect, it } from "vitest";
import {
  KimiXtmlRecovery,
  recoverKimiXtmlFromText,
  renderKimiXtmlCalls,
} from "./kimiXtml.js";

const tools = [
  {
    name: "search",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        tags: { type: "array" },
        exact: { type: "boolean" },
      },
      required: ["query"],
    },
  },
];
const arg = (k: string, t: string, v: string) =>
  `<|open|>argument key="${k}" type="${t}"<|sep|>${v}<|close|>argument<|sep|>`;
const call = (i: number, ...args: string[]) =>
  `<|open|>call tool="search" index="${i}"<|sep|>${args.join("")}<|close|>call<|sep|>`;
const part = (...calls: string[]) =>
  `<|open|>tools<|sep|>${calls.join("")}<|close|>tools<|sep|>`;
const q = arg("query", "string", "x");

describe("kimi-xtml recovery", () => {
  it("round-trips typed values, two calls, and a string that needs no escape", () => {
    const calls = [
      {
        name: "search",
        arguments: { query: 'a & "b"', limit: 2, tags: ["x"], exact: false },
      },
      { name: "search", arguments: { query: "line1\nline2" } },
    ];
    const r = recoverKimiXtmlFromText(renderKimiXtmlCalls(calls), tools);
    expect(r.calls.map((c) => c.arguments)).toEqual(
      calls.map((c) => c.arguments),
    );
  });

  it("keeps think and response parts as text and takes the message tail", () => {
    const lead =
      "<|open|>think<|sep|>hm<|close|>think<|sep|><|open|>response<|sep|>ok<|close|>response<|sep|>";
    const text = `${lead}${part(call(1, q))}<|close|>message<|sep|><|end_of_msg|>`;
    const r = recoverKimiXtmlFromText(text, tools);
    expect(r.text).toBe(lead);
    expect(r.calls).toHaveLength(1);
  });

  it("accepts a reply whose think opening the server removed", () => {
    const text = `<|close|>think<|sep|>${part(call(1, q))}`;
    const r = recoverKimiXtmlFromText(text, tools);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toBe("<|close|>think<|sep|>");
  });

  it("reads a string for an integer parameter by the shared rule, and says so", () => {
    const r = recoverKimiXtmlFromText(
      part(call(1, q, arg("limit", "string", "5"))),
      tools,
    );
    expect(r.calls[0].arguments).toEqual({ query: "x", limit: 5 });
    expect(r.calls[0].repairs).toHaveLength(1);
  });

  it.each([
    ["prose before", `ok ${part(call(1, q))}`],
    ["undeclared tool", part(call(1, q)).replace('tool="search"', 'tool="rm"')],
    ["index not 1", part(call(2, q))],
    ["unknown type", part(call(1, arg("query", "text", "x")))],
    [
      "number type, text not a number",
      part(call(1, q, arg("limit", "number", "two"))),
    ],
    [
      "type says number, text is a string literal",
      part(call(1, q, arg("limit", "number", '"5"'))),
    ],
    ["duplicate key", part(call(1, q, arg("query", "string", "y")))],
    ["undeclared key", part(call(1, q, arg("zzz", "string", "y")))],
    ["missing required", part(call(1))],
    [
      "raw json block",
      part(
        `<|open|>call tool="search" index="1"<|sep|><|open|>json type="object"<|sep|>{"query":"x"}<|close|>json<|sep|><|close|>call<|sep|>`,
      ),
    ],
    ["no tools close", part(call(1, q)).replace("<|close|>tools<|sep|>", "")],
    ["text after", `${part(call(1, q))} done`],
    ["only a response", "<|open|>response<|sep|>hi<|close|>response<|sep|>"],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverKimiXtmlFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("does not hold a reply that does not start like a call", () => {
    const r = new KimiXtmlRecovery(tools);
    expect(r.push("Done.")).toEqual([{ type: "text", text: "Done." }]);
  });
});
