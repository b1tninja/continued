import { describe, expect, it } from "vitest";
import {
  recoverDeepseekR1FromText,
  renderDeepseekR1Call,
  renderDeepseekR1Calls,
} from "./deepseekR1.js";
import { renderDeepseekV31Call } from "./deepseekV31.js";

const tools = [
  {
    name: "get_weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];
const paris = { name: "get_weather", arguments: { city: "Paris" } };

describe("deepseek-r1 layout", () => {
  it("recovers one call and several", () => {
    const one = recoverDeepseekR1FromText(
      renderDeepseekR1Calls([paris]),
      tools,
    );
    expect(one.text).toBe("");
    expect(one.calls.map((c) => c.arguments)).toEqual([{ city: "Paris" }]);
    const two = recoverDeepseekR1FromText(
      renderDeepseekR1Calls([paris, { ...paris, arguments: { city: "Rome" } }]),
      tools,
    );
    expect(two.calls.map((c) => c.arguments)).toEqual([
      { city: "Paris" },
      { city: "Rome" },
    ]);
  });

  it("is the layout of the template: function, name, newline, json fence", () => {
    expect(renderDeepseekR1Call(paris)).toBe(
      '<｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n```json\n{"city":"Paris"}\n```<｜tool▁call▁end｜>',
    );
  });

  it("refuses the V3.1 layout, a wrong type, a missing fence and prose", () => {
    const good = renderDeepseekR1Calls([paris]);
    const refused = [
      `<｜tool▁calls▁begin｜>${renderDeepseekV31Call(paris)}<｜tool▁calls▁end｜>`,
      good.replace("function<", "tool<"),
      good.replace("\n```json\n", "\n"),
      good.replace("\n```<", "```<"),
      `Sure. ${good}`,
      `${good} Done.`,
      good.replace("<｜tool▁calls▁end｜>", ""),
      good.replace("get_weather\n", "delete_all\n"),
      good.replace('"Paris"', "Paris"),
    ];
    for (const text of refused) {
      expect(recoverDeepseekR1FromText(text, tools), text).toEqual({
        text,
        calls: [],
      });
    }
  });

  it("refuses arguments that do not fit the tool's schema", () => {
    const text = renderDeepseekR1Calls([
      { name: "get_weather", arguments: { town: "Paris" } },
    ]);
    expect(recoverDeepseekR1FromText(text, tools).calls).toEqual([]);
  });

  it("keeps a leading think block as text and accepts the end token", () => {
    const text = `<think>hm</think>\n${renderDeepseekR1Calls([paris])}<｜end▁of▁sentence｜>`;
    const out = recoverDeepseekR1FromText(text, tools);
    expect(out.text).toBe("<think>hm</think>\n");
    expect(out.calls).toHaveLength(1);
  });
});
