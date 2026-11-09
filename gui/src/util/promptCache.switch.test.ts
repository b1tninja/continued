import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import {
  formatSwitchCost,
  promptCacheStatus,
  switchCost,
  type PromptCacheSessionState,
} from "./promptCache";

const MIN = 60 * 1000;
const t0 = 1_000_000_000;
const sonnet: ModelDescription = {
  title: "s",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
};

/** Claude Sonnet's row: $3 input, 5-minute write 1.25x, 1-hour write 2x, read 0.1x. */
const sonnetPrice = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheWrite1h: 6,
  cacheRead: 0.3,
};

const warm = (extra: Partial<PromptCacheSessionState> = {}) => ({
  escalated: false,
  lastRequestAt: t0,
  lastTtl: "5m" as const,
  lastInputTokens: 84_000,
  ...extra,
});

describe("switchCost", () => {
  it("is undefined when the cache is cold", () => {
    const state = warm();
    const status = promptCacheStatus(sonnet, "auto", state, t0 + 6 * MIN);
    expect(switchCost(status, state, sonnetPrice)).toBeUndefined();
  });

  it("is undefined when caching is off", () => {
    const state = warm();
    const status = promptCacheStatus(sonnet, "off", state, t0 + MIN);
    expect(switchCost(status, state, sonnetPrice)).toBeUndefined();
  });

  it("is undefined before any request size is known", () => {
    const state = warm({ lastInputTokens: undefined });
    const status = promptCacheStatus(sonnet, "auto", state, t0 + MIN);
    expect(switchCost(status, state, sonnetPrice)).toBeUndefined();
  });

  it("prices the next request at the 5-minute write rate minus the read rate", () => {
    const state = warm();
    const status = promptCacheStatus(sonnet, "auto", state, t0 + MIN);
    const cost = switchCost(status, state, sonnetPrice)!;
    expect(cost.tokens).toBe(84_000);
    // 84,000 tokens * $3/MTok * (1.25 - 0.1)
    expect(cost.extraUsd).toBeCloseTo(0.2898, 4);
  });

  it("uses the 1-hour write rate when the entry was written for 1 hour", () => {
    const state = warm({ escalated: true, lastTtl: "1h" });
    const status = promptCacheStatus(sonnet, "auto", state, t0 + MIN);
    const cost = switchCost(status, state, sonnetPrice)!;
    // 84,000 tokens * $3/MTok * (2 - 0.1)
    expect(cost.extraUsd).toBeCloseTo(0.4788, 4);
  });

  it("still reports tokens when the model has no price", () => {
    const state = warm();
    const status = promptCacheStatus(sonnet, "auto", state, t0 + MIN);
    const cost = switchCost(status, state, null)!;
    expect(cost.tokens).toBe(84_000);
    expect(cost.extraUsd).toBeUndefined();
  });
});

describe("formatSwitchCost", () => {
  it.each([
    [{ tokens: 84_000, extraUsd: 0.2898 }, "84k tokens (about $0.29 more)"],
    [{ tokens: 800, extraUsd: 0.001 }, "800 tokens (under $0.01 more)"],
    [{ tokens: 120_000 }, "120k tokens"],
  ])("%j -> %s", (cost, expected) => {
    expect(formatSwitchCost(cost)).toBe(expected);
  });
});
