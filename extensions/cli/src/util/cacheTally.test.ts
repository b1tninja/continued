import { afterEach, describe, expect, it } from "vitest";

import {
  formatCacheTally,
  getCacheTally,
  recordCacheTally,
  resetCacheTally,
} from "./cacheTally.js";

afterEach(() => resetCacheTally());

const claude = (prompt: number, read: number, write: number) => ({
  promptTokens: prompt,
  completionTokens: 10,
  promptTokensDetails: { cachedTokens: read, cacheWriteTokens: write },
});

describe("cache tally", () => {
  it("adds a Claude request's cache counts to its prompt tokens", () => {
    // promptTokens leaves out the cache for Claude: 5 + 900 + 100 = 1,005
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 900, 100));
    expect(getCacheTally()).toEqual({
      requests: 1,
      inputTokens: 1005,
      readTokens: 900,
      writeTokens: 100,
    });
  });

  it("takes a GPT request's prompt tokens as the whole input", () => {
    recordCacheTally("openai", "gpt-5.5", claude(1000, 800, 0));
    expect(getCacheTally().inputTokens).toBe(1000);
    expect(getCacheTally().readTokens).toBe(800);
  });

  it("keeps a mixed session right, request by request", () => {
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 900, 100));
    recordCacheTally("openai", "gpt-5.5", claude(1000, 800, 0));
    expect(getCacheTally()).toEqual({
      requests: 2,
      inputTokens: 2005,
      readTokens: 1700,
      writeTokens: 100,
    });
  });

  it("works for Bedrock Claude IDs", () => {
    recordCacheTally(
      "anthropic",
      "us.anthropic.claude-sonnet-4-6",
      claude(5, 900, 100),
    );
    expect(getCacheTally().inputTokens).toBe(1005);
  });

  it("ignores a request with no input and a missing details block", () => {
    recordCacheTally("anthropic", "claude-sonnet-4-6", {
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(getCacheTally().requests).toBe(0);
    recordCacheTally("anthropic", "claude-sonnet-4-6", {
      promptTokens: 500,
      completionTokens: 5,
    });
    expect(getCacheTally()).toEqual({
      requests: 1,
      inputTokens: 500,
      readTokens: 0,
      writeTokens: 0,
    });
  });
});

describe("formatCacheTally", () => {
  it("says nothing when the cache was never used", () => {
    expect(formatCacheTally()).toBeUndefined();
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(500, 0, 0));
    expect(formatCacheTally()).toBeUndefined();
  });

  it("gives requests, hit share, and tokens read and written", () => {
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 0, 1000));
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 1000, 200));
    expect(formatCacheTally()).toBe(
      "Prompt cache: 2 requests, 45% of input read from the cache " +
        "(1,000 of 2,210 tokens), 1,200 tokens written",
    );
  });

  it("uses the singular for one request", () => {
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 0, 1000));
    expect(formatCacheTally()).toContain("1 request,");
    expect(formatCacheTally()).toContain("0% of input");
  });

  it("does not claim anything about misses", () => {
    recordCacheTally("anthropic", "claude-sonnet-4-6", claude(5, 100, 100));
    expect(formatCacheTally()?.toLowerCase()).not.toContain("miss");
  });
});
