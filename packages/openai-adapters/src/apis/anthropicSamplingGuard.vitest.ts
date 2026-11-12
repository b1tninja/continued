import { describe, expect, it } from "vitest";
import { AnthropicApi } from "./Anthropic.js";
import { claudeRefusesSampling } from "./anthropicSamplingGuard.js";
import { bedrockSamplingParams } from "./bedrockHelpers.js";

describe("claudeRefusesSampling (adapter copy)", () => {
  it("matches Claude 4.7 and later only", () => {
    for (const m of [
      "claude-opus-4-7",
      "claude-sonnet-5-5",
      "claude-mythos-preview",
      "claude-haiku-5-5",
    ]) {
      expect(claudeRefusesSampling(m), m).toBe(true);
    }
    for (const m of [
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "gpt-5",
    ]) {
      expect(claudeRefusesSampling(m), m).toBe(false);
    }
  });

  const api = new AnthropicApi({ provider: "anthropic", apiKey: "k" });
  const messages = [{ role: "user" as const, content: "Hi" }];
  type S = { temperature?: number; top_p?: number; top_k?: number };

  it("leaves the sampling fields out for a refusing model", () => {
    const b = api._convertToCleanAnthropicBody({
      model: "claude-opus-4-8",
      messages,
      temperature: 0.5,
      top_p: 0.9,
    }) as S;
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  it("is unchanged for an earlier model", () => {
    const b = api._convertToCleanAnthropicBody({
      model: "claude-sonnet-4-5",
      messages,
      temperature: 0.5,
    }) as S;
    expect(b.temperature).toBe(0.5);
  });

  it("applies on Bedrock", () => {
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-opus-4-8-v1:0",
        0.5,
        undefined,
        false,
      ),
    ).toEqual({});
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-sonnet-4-6",
        0.5,
        undefined,
        false,
      ),
    ).toEqual({ temperature: 0.5 });
  });
});
