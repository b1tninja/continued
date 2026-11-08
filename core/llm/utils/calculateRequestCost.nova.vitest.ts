import { describe, expect, it } from "vitest";

import type { Usage } from "../..";

import { bedrockCachePointFields } from "../llms/bedrockHelpers";
import {
  bedrockRegionalPriceFactor,
  calculateRequestCost,
  findModelPricing,
  normalizeNovaModelId,
  NOVA_PRICING,
} from "./calculateRequestCost";

/**
 * Amazon Nova on Bedrock, from the Amazon Nova tables of
 * aws.amazon.com/bedrock/pricing (Standard tier, US East (Ohio), read
 * 2026-11-08): Nova 2 Lite $0.30 / $2.50 global and $0.33 / $2.75 geo
 * cross-region and in-region; Nova Pro $0.80 / $3.20, Nova Lite $0.06 / $0.24
 * and Nova Micro $0.035 / $0.14 at one price. Cache reads are 75% below the
 * input price; the page lists no write price, so a write is estimated at the
 * input price.
 */
const MTOK = 1_000_000;

describe("normalizeNovaModelId", () => {
  it.each([
    ["amazon.nova-2-lite-v1:0", "nova-2-lite"],
    ["us.amazon.nova-2-lite-v1:0", "nova-2-lite"],
    ["global.amazon.nova-2-lite-v1:0", "nova-2-lite"],
    ["US.Amazon.Nova-Pro-v1:0", "nova-pro"],
    ["amazon.nova-lite-v1:0", "nova-lite"],
    ["eu.amazon.nova-micro-v1:0", "nova-micro"],
  ])("%s -> %s", (id, expected) => {
    expect(normalizeNovaModelId(id)).toBe(expected);
  });

  it.each([
    "amazon.nova-premier-v1:0",
    "us.amazon.nova-2-pro-v1:0",
    "us.amazon.nova-2-omni-v1:0",
    "amazon/nova-pro-v1", // OpenRouter's spelling: not Bedrock, not priced
    "us.anthropic.claude-sonnet-4-6",
    "nova-pro",
  ])("%s is not one of the four", (id) => {
    expect(normalizeNovaModelId(id)).toBeUndefined();
  });

  it("prices exactly the models that take cache points", () => {
    for (const id of [
      "amazon.nova-2-lite-v1:0",
      "amazon.nova-pro-v1:0",
      "amazon.nova-lite-v1:0",
      "amazon.nova-micro-v1:0",
      "amazon.nova-premier-v1:0",
      "us.amazon.nova-2-pro-v1:0",
    ]) {
      expect(normalizeNovaModelId(id) !== undefined).toBe(
        bedrockCachePointFields(id) !== undefined,
      );
    }
  });
});

describe("Nova list prices", () => {
  it.each([
    ["nova-2-lite", 0.3, 2.5],
    ["nova-pro", 0.8, 3.2],
    ["nova-lite", 0.06, 0.24],
    ["nova-micro", 0.035, 0.14],
  ])(
    "%s: $%s in, $%s out, read a quarter, write at input",
    (key, input, output) => {
      const p = NOVA_PRICING[key];
      expect(p.input).toBe(input);
      expect(p.output).toBe(output);
      expect(p.cacheRead).toBeCloseTo(input / 4, 9);
      expect(p.cacheWrite).toBe(input);
      expect(p.cacheWrite1h).toBe(input);
      expect(p.longContext).toBeUndefined();
    },
  );

  it("is what findModelPricing returns for a bare or global ID", () => {
    expect(findModelPricing("amazon.nova-2-lite-v1:0")).toEqual(
      NOVA_PRICING["nova-2-lite"],
    );
    expect(findModelPricing("global.amazon.nova-2-lite-v1:0")).toEqual(
      NOVA_PRICING["nova-2-lite"],
    );
    expect(findModelPricing("amazon.nova-premier-v1:0")).toBeNull();
  });
});

describe("Nova 2 Lite regional premium", () => {
  it.each([
    ["us.amazon.nova-2-lite-v1:0", 1.1],
    ["eu.amazon.nova-2-lite-v1:0", 1.1],
    ["apac.amazon.nova-2-lite-v1:0", 1.1],
    ["global.amazon.nova-2-lite-v1:0", 1],
    ["amazon.nova-2-lite-v1:0", 1],
    // One listed price: nothing to scale
    ["us.amazon.nova-pro-v1:0", 1],
    ["us.amazon.nova-lite-v1:0", 1],
    ["us.amazon.nova-micro-v1:0", 1],
    ["us.amazon.nova-premier-v1:0", 1],
  ])("%s has factor %s", (id, factor) => {
    expect(bedrockRegionalPriceFactor(id)).toBe(factor);
  });

  it("gives AWS's geo cross-region figures for a us. profile", () => {
    const p = findModelPricing("us.amazon.nova-2-lite-v1:0")!;
    expect(p.input).toBe(0.33);
    expect(p.output).toBe(2.75);
    expect(p.cacheWrite).toBe(0.33);
    expect(p.cacheRead).toBe(0.0825);
  });
});

describe("calculateRequestCost for Nova on Bedrock", () => {
  it("prices input, output and a cache read", () => {
    const usage: Usage = {
      promptTokens: 101,
      completionTokens: 400,
      promptTokensDetails: { cachedTokens: 3022, cacheWriteTokens: 0 },
    };
    const r = calculateRequestCost(
      "bedrock",
      "amazon.nova-2-lite-v1:0",
      usage,
    )!;
    expect(r).not.toBeNull();
    const expected =
      (101 / MTOK) * 0.3 + (400 / MTOK) * 2.5 + (3022 / MTOK) * 0.075;
    expect(r.cost).toBeCloseTo(expected, 9);
    expect(r.breakdown).toContain("Cache Read: 3,022 tokens × $0.075/MTok");
    expect(r.breakdown).not.toContain("Prices:");
  });

  it("prices a cache write at the input rate", () => {
    const usage: Usage = {
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 3123 },
    };
    const r = calculateRequestCost(
      "bedrock",
      "amazon.nova-2-lite-v1:0",
      usage,
    )!;
    expect(r.cost).toBeCloseTo((3123 / MTOK) * 0.3, 9);
    expect(r.breakdown).toContain("Cache Write (5m): 3,123 tokens × $0.3/MTok");
  });

  it("says in the breakdown that a us. profile is AWS list times 1.1", () => {
    const usage: Usage = { promptTokens: MTOK, completionTokens: 0 };
    const us = calculateRequestCost(
      "bedrock",
      "us.amazon.nova-2-lite-v1:0",
      usage,
    )!;
    expect(us.cost).toBeCloseTo(0.33, 9);
    expect(us.breakdown).toContain(
      "Prices: AWS list × 1.1 (Bedrock regional endpoint)",
    );
  });

  it.each([
    ["us.amazon.nova-pro-v1:0", 0.8, 3.2],
    ["amazon.nova-lite-v1:0", 0.06, 0.24],
    ["amazon.nova-micro-v1:0", 0.035, 0.14],
  ])("%s costs $%s per MTok in and $%s out", (id, input, output) => {
    const r = calculateRequestCost("bedrock", id, {
      promptTokens: MTOK,
      completionTokens: MTOK,
    })!;
    expect(r.cost).toBeCloseTo(input + output, 9);
  });

  it("is Bedrock only: the same model through another provider is unpriced", () => {
    const usage: Usage = { promptTokens: 1000, completionTokens: 1000 };
    expect(
      calculateRequestCost("openrouter", "amazon/nova-pro-v1", usage),
    ).toBeNull();
    expect(
      calculateRequestCost("openai", "amazon.nova-pro-v1:0", usage),
    ).toBeNull();
  });
});
