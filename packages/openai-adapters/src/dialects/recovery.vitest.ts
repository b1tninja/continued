import { describe, expect, it } from "vitest";
import {
  createTextToolRecovery,
  dialectToolsFromConverse,
  recoverFromText,
  recoverySetting,
} from "./recovery.js";

const tools = [{ name: "Read", parameters: { properties: { p: {} } } }];
const text = "<function=Read>\n<parameter=p>\nx\n</parameter>\n</function>";

describe("text tool recovery switch", () => {
  it("is off without a setting, for any model", () => {
    expect(createTextToolRecovery("qwen.qwen3-coder", tools, {}, {})).toBe(
      undefined,
    );
    expect(recoverFromText("qwen.qwen3-coder", text, tools, {}, {})).toEqual({
      text,
      calls: [],
    });
  });

  it("reads the request field before the environment", () => {
    expect(
      recoverySetting(
        { x_continue_recover_text_tool_calls: "qwen-xml" },
        { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "other" },
      ),
    ).toBe("qwen-xml");
    expect(
      recoverySetting({}, { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "qwen-xml" }),
    ).toBe("qwen-xml");
  });

  it("applies only to the family the setting names", () => {
    const env = { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "qwen-xml" };
    expect(
      createTextToolRecovery("us.amazon.nova-2-lite", tools, {}, env),
    ).toBe(undefined);
    expect(
      createTextToolRecovery("qwen.qwen3-coder", tools, {}, env),
    ).toBeDefined();
    const out = recoverFromText("qwen.qwen3-coder", text, tools, {}, env);
    expect(out.calls.map((c) => c.name)).toEqual(["Read"]);
  });

  it("reads tools out of a Converse toolConfig", () => {
    expect(
      dialectToolsFromConverse({
        tools: [
          {
            toolSpec: { name: "A", inputSchema: { json: { type: "object" } } },
          },
          {},
        ],
      }),
    ).toEqual([{ name: "A", parameters: { type: "object" } }]);
    expect(dialectToolsFromConverse(undefined)).toEqual([]);
  });
});
