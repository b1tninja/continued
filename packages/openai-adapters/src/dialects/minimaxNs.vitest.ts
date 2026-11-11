import { describe, expect, it } from "vitest";
import {
  MinimaxNsRecovery,
  recoverMinimaxNsFromText,
  renderMinimaxNsCalls,
} from "./minimaxNs.js";

const NS = "]<]minimax[>[";
const tools = [
  {
    name: "make",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "integer" },
        on: { type: "boolean" },
        steps: { type: "array", items: { type: "string" } },
        pts: {
          type: "array",
          items: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
          },
        },
        opts: {
          type: "object",
          properties: { n: { type: "integer" }, s: { type: "string" } },
        },
      },
      required: ["title"],
    },
  },
];
const p = (k: string, v: string) => `${NS}<${k}>${v}${NS}</${k}>`;
const block = (...params: string[]) =>
  `${NS}<tool_call>\n${NS}<invoke name="make">${params.join("")}${NS}</invoke>\n${NS}</tool_call>`;

describe("minimax-ns-xml recovery", () => {
  it("round-trips scalars, arrays and nested objects", () => {
    const args = {
      title: "t",
      count: 3,
      on: true,
      steps: ["a", "b"],
      pts: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      opts: { n: 7, s: "z" },
    };
    const r = recoverMinimaxNsFromText(
      renderMinimaxNsCalls([{ name: "make", arguments: args }]),
      tools,
    );
    expect(r.calls.map((c) => c.arguments)).toEqual([args]);
    expect(r.text).toBe("");
  });

  it("reads an empty array and an empty object from an empty tag", () => {
    const r = recoverMinimaxNsFromText(
      block(p("title", "t"), p("steps", ""), p("opts", "")),
      tools,
    );
    expect(r.calls[0].arguments).toEqual({ title: "t", steps: [], opts: {} });
  });

  it("keeps an empty string for a string parameter", () => {
    const r = recoverMinimaxNsFromText(block(p("title", "")), tools);
    expect(r.calls[0].arguments).toEqual({ title: "" });
  });

  it("keeps thinking, or the bare close, as text", () => {
    for (const lead of ["<mm:think>hm</mm:think>", "</mm:think>\n"]) {
      const r = recoverMinimaxNsFromText(lead + block(p("title", "t")), tools);
      expect(r.text).toBe(lead);
      expect(r.calls).toHaveLength(1);
    }
  });

  it.each([
    ["prose before", `ok ${block(p("title", "t"))}`],
    ["prose after", `${block(p("title", "t"))} ok`],
    ["namespace token stripped", block(p("title", "t")).replaceAll(NS, "")],
    ["unknown tool", block(p("title", "t")).replace('"make"', '"rm"')],
    ["integer not a number", block(p("title", "t"), p("count", "two"))],
    ["integer written 1.0", block(p("title", "t"), p("count", "1.0"))],
    ["undeclared argument", block(p("title", "t"), p("zzz", "1"))],
    ["duplicate key", block(p("title", "t"), p("title", "u"))],
    [
      "duplicate nested key",
      block(p("title", "t"), p("opts", p("n", "1") + p("n", "2"))),
    ],
    ["nested leaf cannot fit", block(p("title", "t"), p("opts", p("n", "x")))],
    ["missing required", block(p("count", "1"))],
    ["mismatched close", block(`${NS}<title>t${NS}</count>`)],
    ["unclosed block", block(p("title", "t")).replace(`${NS}</tool_call>`, "")],
    ["two blocks", block(p("title", "t")) + block(p("title", "u"))],
    ["empty block", `${NS}<tool_call>\n${NS}</tool_call>`],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverMinimaxNsFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("does not hold a reply that does not start like a call", () => {
    const r = new MinimaxNsRecovery(tools);
    expect(r.push("Done.")).toEqual([{ type: "text", text: "Done." }]);
  });
});
