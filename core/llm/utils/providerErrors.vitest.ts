import {
  bedrockRefusedField,
  converseRequestHasField,
  converseRequestWithoutField,
} from "@continuedev/llm-info";
import { describe, expect, it } from "vitest";

describe("bedrockRefusedField", () => {
  it.each([
    [
      "This model doesn't support the stopSequences field. Remove stopSequences and try again.",
      "stopSequences",
    ],
    ["This model doesn’t support the cachePoint field", "cachePoint"],
    [
      "Malformed input request: extraneous key [cachePoint] is not permitted",
      "cachePoint",
    ],
    ["The model or request does not allow prompt caching", "cachePoint"],
  ])("reads %j as a refusal of %s", (message, field) => {
    expect(bedrockRefusedField(new Error(message))).toBe(field);
    expect(bedrockRefusedField(message)).toBe(field);
    expect(bedrockRefusedField({ message })).toBe(field);
  });

  it.each([
    "This model doesn't support the toolConfig field",
    "User: dev is not authorized to perform: bedrock:InvokeModel",
    "Too many requests, please wait before trying again",
    "extraneous key [unknownThing] is not permitted",
    "",
  ])("leaves %j alone: not a cost-only field, or not a refusal", (message) => {
    expect(bedrockRefusedField(new Error(message))).toBeUndefined();
  });

  it("copes with non-error values", () => {
    expect(bedrockRefusedField(undefined)).toBeUndefined();
    expect(bedrockRefusedField(42)).toBeUndefined();
  });
});

describe("converse request fields", () => {
  const point = { cachePoint: { type: "default" } };
  const request = {
    modelId: "m",
    inferenceConfig: { maxTokens: 10, stopSequences: ["END"] },
    system: [{ text: "sys" }, point],
    toolConfig: { tools: [{ toolSpec: { name: "t" } }, point] },
    messages: [
      { role: "user", content: [{ text: "hi" }, point] },
      { role: "assistant", content: [{ text: "ok" }] },
    ],
  };

  it("sees both fields in a request that carries them", () => {
    expect(converseRequestHasField(request, "stopSequences")).toBe(true);
    expect(converseRequestHasField(request, "cachePoint")).toBe(true);
  });

  it("drops stop sequences and nothing else", () => {
    const out = converseRequestWithoutField(request, "stopSequences");
    expect(out.inferenceConfig).toEqual({
      maxTokens: 10,
      stopSequences: undefined,
    });
    expect(out.system).toBe(request.system);
    expect(converseRequestHasField(out, "stopSequences")).toBe(false);
    expect(converseRequestHasField(out, "cachePoint")).toBe(true);
  });

  it("drops every cache point block and keeps the content", () => {
    const out = converseRequestWithoutField(request, "cachePoint");
    expect(JSON.stringify(out)).not.toContain("cachePoint");
    expect(out.system).toEqual([{ text: "sys" }]);
    expect(out.toolConfig?.tools).toEqual([{ toolSpec: { name: "t" } }]);
    expect(out.messages?.map((m: { content?: unknown }) => m.content)).toEqual([
      [{ text: "hi" }],
      [{ text: "ok" }],
    ]);
    expect(out.inferenceConfig?.stopSequences).toEqual(["END"]);
    // the input is not changed
    expect(converseRequestHasField(request, "cachePoint")).toBe(true);
  });

  it("reports an absent field as absent", () => {
    const bare = { modelId: "m", messages: [{ content: [{ text: "x" }] }] };
    expect(converseRequestHasField(bare, "stopSequences")).toBe(false);
    expect(converseRequestHasField(bare, "cachePoint")).toBe(false);
  });
});
