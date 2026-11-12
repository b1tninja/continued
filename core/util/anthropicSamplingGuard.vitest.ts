import { describe, expect, it } from "vitest";
import Anthropic from "../llm/llms/Anthropic.js";
import { bedrockSamplingParams } from "../llm/llms/bedrockHelpers.js";
import { claudeRefusesSampling } from "./anthropicSamplingGuard.js";
import { resolveFact, surfaceFamily } from "./surfaceFacts.js";

const REFUSED = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-4-7-opus",
  "us.anthropic.claude-opus-4-8-v1:0",
];
const ACCEPTED = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
  "claude-2.1",
  "gpt-5",
  "",
];

describe("claudeRefusesSampling", () => {
  it.each(REFUSED)("refuses %s", (m) => {
    expect(claudeRefusesSampling(m)).toBe(true);
  });
  it.each(ACCEPTED)("accepts %j", (m) => {
    expect(claudeRefusesSampling(m)).toBe(false);
  });
  it("agrees with the samplingParams surface facts", () => {
    for (const m of [...REFUSED, ...ACCEPTED]) {
      const f = resolveFact("samplingParams", {
        provider: "anthropic",
        api: "messages",
        modelFamily: surfaceFamily(undefined, m),
      });
      expect(f.value === "refused", m).toBe(claudeRefusesSampling(m));
      if (f.value) {
        expect(f.source).toMatch(/^https:\/\//);
        expect(f.readOn).toBe("2026-11-11");
      }
    }
  });
});

describe("request building", () => {
  const llm = new Anthropic({
    apiKey: "k",
    model: "claude-opus-4-8",
    apiBase: "https://api.anthropic.com/v1/",
  });

  it("omits temperature, top_p and top_k for Claude 4.7 and later", () => {
    const a = llm.convertArgs({
      model: "claude-opus-4-8",
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
    });
    expect(a.temperature).toBeUndefined();
    expect(a.top_p).toBeUndefined();
    expect(a.top_k).toBeUndefined();
  });

  it("is unchanged for earlier models", () => {
    const a = llm.convertArgs({
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      topK: 40,
    });
    expect(a.temperature).toBe(0.5);
    expect(a.top_k).toBe(40);
  });

  it("omits the Converse sampling fields on Bedrock for refusing models", () => {
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-opus-4-8-v1:0",
        0.5,
        0.9,
        false,
      ),
    ).toEqual({});
    expect(
      bedrockSamplingParams("us.anthropic.claude-sonnet-4-6", 0.5, 0.9, false),
    ).toEqual({ temperature: 0.5 });
    expect(
      bedrockSamplingParams("amazon.nova-pro-v1:0", 0.5, 0.9, false),
    ).toEqual({ temperature: 0.5, topP: 0.9 });
  });
});
