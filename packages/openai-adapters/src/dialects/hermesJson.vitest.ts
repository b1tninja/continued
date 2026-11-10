import { describe, expect, it } from "vitest";
import {
  HermesJsonRecovery,
  recoverHermesJsonFromText,
  renderHermesJsonCall,
} from "./hermesJson.js";

const tools = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
];
const call = { name: "read_file", arguments: { path: "a.ts", limit: 3 } };

describe("hermes-json recovery", () => {
  it("recovers a rendered call and its parallel pair", () => {
    const one = recoverHermesJsonFromText(renderHermesJsonCall(call), tools);
    expect(one.calls.map((c) => c.arguments)).toEqual([call.arguments]);
    expect(one.text).toBe("");
    const two = recoverHermesJsonFromText(
      `${renderHermesJsonCall(call)}\n${renderHermesJsonCall(call)}`,
      tools,
    );
    expect(two.calls).toHaveLength(2);
  });

  it("keeps a leading think block as text", () => {
    const r = recoverHermesJsonFromText(
      `<think>x</think>\n${renderHermesJsonCall(call)}`,
      tools,
    );
    expect(r.text).toBe("<think>x</think>\n");
    expect(r.calls).toHaveLength(1);
  });

  it.each([
    ["prose around the call", `ok\n${renderHermesJsonCall(call)}`],
    ["trailing prose", `${renderHermesJsonCall(call)}\ndone`],
    ["unknown tool", renderHermesJsonCall({ ...call, name: "rm" })],
    [
      "undeclared argument",
      renderHermesJsonCall({ ...call, arguments: { path: "a", x: 1 } }),
    ],
    [
      "numeric string for integer",
      renderHermesJsonCall({ ...call, arguments: { path: "a", limit: "3" } }),
    ],
    [
      "missing required",
      renderHermesJsonCall({ ...call, arguments: { limit: 1 } }),
    ],
    ["truncated", renderHermesJsonCall(call).slice(0, -12)],
  ])("leaves %s as text", (_n, text) => {
    expect(recoverHermesJsonFromText(text, tools)).toEqual({ text, calls: [] });
  });

  it("releases a reply that cannot start a call without holding it", () => {
    const r = new HermesJsonRecovery(tools);
    expect(r.push("Hello")).toEqual([{ type: "text", text: "Hello" }]);
    expect(r.push(" there")).toEqual([{ type: "text", text: " there" }]);
    expect(r.end()).toEqual([]);
  });
});
