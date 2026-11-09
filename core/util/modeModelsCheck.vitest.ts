import { describe, expect, it } from "vitest";
import {
  checkModeModels,
  ignoredReasoningEffort,
  unusableModeModelNames,
} from "./modeModelsCheck";

const models = [
  { name: "Opus", provider: "anthropic", roles: ["chat"] },
  { name: "Sonnet", provider: "bedrock" },
  { name: "Judge", provider: "openai", roles: ["reviewer"] },
  { name: "Mini", provider: "openai", roles: ["chat"] },
];

describe("unusableModeModelNames", () => {
  it("is quiet for a good config", () => {
    expect(
      unusableModeModelNames(
        { plan: { model: "Opus" }, agent: { model: "Sonnet" } },
        models,
      ),
    ).toEqual([]);
  });

  it("flags an unknown name, including one in `models`", () => {
    const w = unusableModeModelNames(
      { plan: { model: "Nope" }, chat: { models: ["Opus", "Gone"] } },
      models,
    );
    expect(w.map((x) => x.use)).toEqual(["chat", "plan"]);
    expect(w[1].message).toContain('no model named "Nope"');
  });

  it("flags a non-chat model, except for the reviewer", () => {
    const w = unusableModeModelNames(
      { loop: { model: "Judge" }, reviewer: { model: "Judge" } },
      models,
    );
    expect(w).toHaveLength(1);
    expect(w[0].use).toBe("loop");
    expect(w[0].message).toContain("not a chat model");
  });

  it("handles no modeModels", () => {
    expect(unusableModeModelNames(undefined, models)).toEqual([]);
  });
});

describe("ignoredReasoningEffort", () => {
  it("flags the anthropic provider only", () => {
    const w = ignoredReasoningEffort(
      {
        plan: { model: "Opus", reasoningEffort: "high" },
        agent: { model: "Sonnet", reasoningEffort: "low" },
        loop: { model: "Mini", reasoningEffort: "low" },
      },
      models,
    );
    expect(w).toHaveLength(1);
    expect(w[0].use).toBe("plan");
    expect(w[0].message).toContain('provider "anthropic"');
  });

  it("ignores entries without an effort and the reviewer", () => {
    expect(
      ignoredReasoningEffort(
        {
          plan: { model: "Opus" },
          reviewer: { model: "Opus", reasoningEffort: "low" },
        },
        models,
      ),
    ).toEqual([]);
  });
});

describe("checkModeModels", () => {
  it("joins both checks", () => {
    const w = checkModeModels(
      {
        plan: { model: "Opus", reasoningEffort: "high" },
        agent: { model: "Nope" },
      },
      models,
    );
    expect(w.map((x) => x.use).sort()).toEqual(["agent", "plan"]);
  });
});
