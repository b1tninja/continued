import {
  PROMPT_CACHE_RULES,
  promptCacheFields,
  promptCacheMinTokens,
  promptCacheModelKey,
  promptCacheRule,
  promptCacheSupportsLifetime,
} from "@continuedev/llm-info";
import { describe, expect, it } from "vitest";

import {
  bedrockCachePointFields,
  bedrockSupportsOneHourCache,
} from "../llms/bedrockHelpers";

import { minCacheableTokens } from "./cacheMinimums";

/**
 * The prompt cache table in @continuedev/llm-info is the one place that says
 * what each model's cache can do. The helpers in core and in the Bedrock
 * adapter are lookups on it, so this checks the table itself: every row is
 * sourced and dated, every row is reachable, and the facts the vendors'
 * tables give come back for the IDs each provider uses.
 */
describe("the prompt cache table", () => {
  it("dates and sources every row", () => {
    for (const rule of PROMPT_CACHE_RULES) {
      expect(["aws", "anthropic", "google"]).toContain(rule.source);
      expect(rule.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A row with cache points names a lifetime; one without names none.
      expect(rule.lifetimes.length > 0).toBe(rule.fields !== undefined);
    }
  });

  it("reaches every row from at least one real model ID", () => {
    const ids: [string, string][] = [
      ["us.anthropic.claude-sonnet-5-5", "bedrock"],
      ["us.anthropic.claude-opus-4-7", "bedrock"],
      ["anthropic.claude-opus-4-5-20251101-v1:0", "bedrock"],
      ["anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock"],
      ["anthropic.claude-sonnet-4-6", "bedrock"],
      ["anthropic.claude-sonnet-5-6", "bedrock"],
      ["anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock"],
      ["anthropic.claude-3-haiku-20240307-v1:0", "bedrock"],
      ["us.amazon.nova-2-lite-v1:0", "bedrock"],
      ["us.openai.gpt-6.1-sol", "bedrock"],
      ["openai.gpt-5.5", "bedrock"],
      ["claude-sonnet-5-5", "anthropic"],
      ["claude-opus-4-7", "anthropic"],
      ["claude-opus-4-6", "anthropic"],
      ["claude-haiku-4-5", "anthropic"],
      ["claude-sonnet-4-6", "anthropic"],
      ["claude-sonnet-4-5", "anthropic"],
      ["claude-3-7-sonnet-20250219", "anthropic"],
      ["gemini-2.5-pro", "gemini"],
      ["gemini-3.1-pro", "gemini"],
    ];
    const reached = new Set(
      ids.map(([m, p]) => PROMPT_CACHE_RULES.indexOf(promptCacheRule(m, p)!)),
    );
    const missed = PROMPT_CACHE_RULES.map((_, i) => i).filter(
      (i) => !reached.has(i),
    );
    expect(missed).toEqual([]);
  });

  it("keys a model the way its provider spells it", () => {
    expect(promptCacheModelKey("us.anthropic.claude-sonnet-4-6-v1:0")).toBe(
      "claude-sonnet-4-6",
    );
    expect(promptCacheModelKey("claude-sonnet-4.6@20260101")).toBe(
      "claude-sonnet-4-6",
    );
    expect(promptCacheModelKey("us.amazon.nova-2-lite-v1:0")).toBe(
      "nova-2-lite",
    );
    expect(promptCacheModelKey("us.openai.gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(promptCacheModelKey("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  describe("Bedrock rows", () => {
    it("give Claude cache points everywhere and a 1-hour option where AWS lists one", () => {
      expect(
        promptCacheFields("us.anthropic.claude-sonnet-5-5", "bedrock"),
      ).toEqual({ tools: true, system: true, messages: true });
      expect(
        promptCacheSupportsLifetime(
          "us.anthropic.claude-sonnet-5-5",
          "bedrock",
          "1h",
        ),
      ).toBe(true);
      // Sonnet 4.5 is not in the AWS table: cache points, 5 minutes only.
      expect(
        promptCacheFields(
          "anthropic.claude-sonnet-4-5-20250929-v1:0",
          "bedrock",
        ),
      ).toEqual({ tools: true, system: true, messages: true });
      expect(
        promptCacheSupportsLifetime(
          "anthropic.claude-sonnet-4-5-20250929-v1:0",
          "bedrock",
          "1h",
        ),
      ).toBe(false);
    });

    it("give Nova the system prompt and messages, 1K, 5 minutes, a 20K cap", () => {
      const row = promptCacheRule("us.amazon.nova-2-lite-v1:0", "bedrock")!;
      expect(row.fields).toEqual({
        tools: false,
        system: true,
        messages: true,
      });
      expect(row.minTokens).toBe(1024);
      expect(row.lifetimes).toEqual(["5m"]);
      expect(row.maxCachedTokens).toBe(20_000);
      expect(row.implicit).toEqual({ reportedInUsage: false });
      expect(promptCacheRule("amazon.nova-premier-v1:0", "bedrock")).toBe(
        undefined,
      );
    });

    it("give GPT no cache point through Converse and implicit caching that usage reports", () => {
      const row = promptCacheRule("us.openai.gpt-6.1-sol", "bedrock")!;
      expect(row.fields).toBeUndefined();
      expect(row.implicit).toEqual({ reportedInUsage: true });
      expect(row.minTokens).toBe(1024);
    });
  });

  describe("the helpers are lookups on it", () => {
    it.each([
      ["us.anthropic.claude-haiku-4-5-20251001-v1:0", true],
      ["global.anthropic.claude-sonnet-5-5", true],
      ["anthropic.claude-sonnet-4-5-20250929-v1:0", false],
      ["anthropic.claude-3-haiku-20240307-v1:0", false],
      ["us.amazon.nova-2-lite-v1:0", false],
      ["xai.grok-4", false],
    ])("bedrockSupportsOneHourCache(%s) is %s", (id, expected) => {
      expect(bedrockSupportsOneHourCache(id)).toBe(expected);
      expect(promptCacheSupportsLifetime(id, "bedrock", "1h")).toBe(expected);
    });

    it("maps the table's messages field to the Bedrock helper's conversation", () => {
      expect(bedrockCachePointFields("us.amazon.nova-pro-v1:0")).toEqual({
        tools: false,
        system: true,
        conversation: true,
      });
      expect(bedrockCachePointFields("openai.gpt-oss-120b-1:0")).toBe(
        undefined,
      );
    });

    it("reads minimums from the same rows", () => {
      expect(minCacheableTokens("anthropic.claude-opus-4-7", "bedrock")).toBe(
        promptCacheMinTokens("anthropic.claude-opus-4-7", "bedrock"),
      );
      expect(minCacheableTokens("claude-opus-4-7", "anthropic")).toBe(2048);
      expect(minCacheableTokens("claude-opus-4-7", "vertexai")).toBe(2048);
    });
  });
});
