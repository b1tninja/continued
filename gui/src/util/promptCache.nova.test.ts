import type { ModelDescription } from "core";
import { findModelPricing } from "core/llm/utils/calculateRequestCost";
import { describe, expect, it } from "vitest";
import {
  cachingIsDefaulted,
  effectiveCacheSetting,
  modelHasFixedCacheLifetime,
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  promptCacheSettingDetail,
  promptCacheStatus,
  resolvePromptCache,
  switchCost,
  type PromptCacheSessionState,
} from "./promptCache";

/**
 * Amazon Nova on Bedrock: the four models the AWS prompt caching table lists
 * take cache points in the system prompt and messages, with one lifetime of
 * 5 minutes and no `ttl`. The chat window treats them as caching models with
 * nothing to choose but on and off.
 */

const MIN = 60 * 1000;
const t0 = 1_000_000_000;

function model(
  provider: string,
  id: string,
  extra: Partial<ModelDescription> = {},
): ModelDescription {
  return {
    title: id,
    provider,
    model: id,
    underlyingProviderName: provider,
    ...extra,
  };
}

const novaLite2 = model("bedrock", "us.amazon.nova-2-lite-v1:0");
const novaPro = model("bedrock", "amazon.nova-pro-v1:0");
const novaPremier = model("bedrock", "us.amazon.nova-premier-v1:0");
const bedrockSonnet = model("bedrock", "us.anthropic.claude-sonnet-4-6");

describe("Nova on Bedrock takes the cache control", () => {
  it.each([
    ["us.amazon.nova-2-lite-v1:0", true],
    ["amazon.nova-2-lite-v1:0", true],
    ["global.amazon.nova-2-lite-v1:0", true],
    ["amazon.nova-pro-v1:0", true],
    ["eu.amazon.nova-lite-v1:0", true],
    ["amazon.nova-micro-v1:0", true],
    // Not in the AWS table: no cache points, so no button
    ["us.amazon.nova-premier-v1:0", false],
    ["us.amazon.nova-2-pro-v1:0", false],
    ["us.amazon.nova-2-omni-v1:0", false],
    ["openai.gpt-oss-120b-1:0", false],
  ])("%s -> %s", (id, expected) => {
    expect(modelSupportsPromptCacheControl(model("bedrock", id))).toBe(
      expected,
    );
  });

  it("is Bedrock only: the same IDs elsewhere get nothing", () => {
    expect(
      modelSupportsPromptCacheControl(
        model("openrouter", "amazon/nova-pro-v1"),
      ),
    ).toBe(false);
    expect(
      modelSupportsPromptCacheControl(
        model("anthropic", "amazon.nova-pro-v1:0"),
      ),
    ).toBe(false);
  });
});

describe("modelHasFixedCacheLifetime", () => {
  it("is true for the Nova models on Bedrock and false for Claude", () => {
    expect(modelHasFixedCacheLifetime(novaLite2)).toBe(true);
    expect(modelHasFixedCacheLifetime(novaPro)).toBe(true);
    expect(modelHasFixedCacheLifetime(bedrockSonnet)).toBe(false);
    expect(
      modelHasFixedCacheLifetime(
        model("bedrock", "anthropic.claude-3-7-sonnet-20250219-v1:0"),
      ),
    ).toBe(false);
  });

  it("is false for models without cache control, and without a model", () => {
    expect(modelHasFixedCacheLifetime(novaPremier)).toBe(false);
    expect(modelHasFixedCacheLifetime(undefined)).toBe(false);
    expect(modelHasFixedCacheLifetime(null)).toBe(false);
  });

  it("goes with no 1-hour lifetime", () => {
    expect(modelSupportsOneHourCache(novaLite2)).toBe(false);
    expect(modelSupportsOneHourCache(novaPro)).toBe(false);
  });
});

describe("the default on Nova", () => {
  it.each(["agent", "plan", "background"])(
    "is 5 minutes, not Auto, in %s when config is silent",
    (mode) => {
      expect(effectiveCacheSetting(novaLite2, undefined, mode)).toBe("5m");
      expect(cachingIsDefaulted(novaLite2, undefined, mode)).toBe(true);
    },
  );

  it("stays off in Chat", () => {
    expect(effectiveCacheSetting(novaLite2, undefined, "chat")).toBeUndefined();
  });

  it("is 5 minutes even when config names a lifetime Nova cannot take", () => {
    const auto = model("bedrock", novaLite2.model, {
      cacheBehavior: { ttl: "auto" },
    } as any);
    const hour = model("bedrock", novaLite2.model, {
      cacheBehavior: { ttl: "1h" },
    } as any);
    expect(effectiveCacheSetting(auto, undefined, "agent")).toBe("5m");
    expect(effectiveCacheSetting(hour, undefined, "agent")).toBe("5m");
  });

  it("gives way to config and to the toolbar", () => {
    const off = model("bedrock", novaLite2.model, {
      completionOptions: { promptCaching: false },
    } as any);
    expect(effectiveCacheSetting(off, undefined, "agent")).toBeUndefined();
    expect(effectiveCacheSetting(novaLite2, "off", "agent")).toBe("off");
  });

  it("describes the config default as 5 minutes in the menu", () => {
    expect(promptCacheSettingDetail("config", novaLite2)).toContain(
      "5 minutes in Agent, Plan and Background",
    );
    expect(promptCacheSettingDetail("config", bedrockSonnet)).toContain(
      "Auto in Agent, Plan and Background",
    );
    expect(promptCacheSettingDetail("5m", novaLite2)).toBe(
      promptCacheSettingDetail("5m", bedrockSonnet),
    );
  });
});

describe("the status ring on Nova runs for 5 minutes", () => {
  const warm: PromptCacheSessionState = {
    escalated: true,
    lastRequestAt: t0,
    lastTtl: "1h",
    lastInputTokens: 20_000,
  };

  it.each(["5m", "auto", "1h"] as const)(
    "reports a 5-minute lifetime under %s, whatever the state says",
    (setting) => {
      const status = promptCacheStatus(novaLite2, setting, warm, t0 + MIN);
      expect(status.on).toBe(true);
      expect(status.ttl).toBe("5m");
      expect(status.warm).toBe(true);
      expect(status.lifetimeMs).toBe(5 * MIN);
      expect(status.msLeft).toBe(4 * MIN);
      expect(status.expiresAt).toBe(t0 + 5 * MIN);
    },
  );

  it("is cold after 5 minutes even if the entry was recorded as 1 hour", () => {
    const status = promptCacheStatus(novaLite2, "auto", warm, t0 + 6 * MIN);
    expect(status.warm).toBe(false);
    expect(status.lifetimeMs).toBeUndefined();
  });

  it("knows Nova's 1,024-token minimum", () => {
    const small = { ...warm, lastInputTokens: 900 };
    const status = promptCacheStatus(novaLite2, "5m", small, t0 + MIN);
    expect(status.belowMinimum).toEqual({ tokens: 900, minimum: 1024 });
    expect(status.warm).toBe(false);
  });

  it("records 5 minutes as the lifetime of each request", () => {
    const first = resolvePromptCache(
      novaLite2,
      "5m",
      { escalated: false },
      t0,
      "agent",
    );
    expect(first.options).toEqual({
      promptCaching: true,
      promptCacheTtl: "5m",
    });
    expect(first.nextState.lastTtl).toBe("5m");

    // A stale Auto choice that has escalated still ends at 5 minutes.
    const stale = resolvePromptCache(
      novaLite2,
      "auto",
      { escalated: true, requests: 9, lastRequestAt: t0 },
      t0 + MIN,
      "agent",
    );
    expect(stale.nextState.lastTtl).toBe("5m");
  });
});

describe("switching away from a warm Nova cache", () => {
  it("prices the re-read at the input price minus the read price", () => {
    const state: PromptCacheSessionState = {
      escalated: false,
      lastRequestAt: t0,
      lastTtl: "5m",
      lastInputTokens: 20_000,
    };
    const status = promptCacheStatus(novaLite2, "5m", state, t0 + MIN);
    const cost = switchCost(status, state, findModelPricing(novaLite2.model))!;
    expect(cost.tokens).toBe(20_000);
    // 20,000 tokens * ($0.33 input, as Nova has no write rate, - $0.0825 read)/MTok
    expect(cost.extraUsd).toBeCloseTo(0.00495, 6);
  });
});
