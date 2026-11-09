import { describe, expect, it } from "vitest";

import type { Usage } from "../..";

import { bedrockCachePointFields } from "../llms/bedrockHelpers";
import {
  bedrockRegionalPriceFactor,
  calculateRequestCost,
  findModelPricing,
  findNovaPricing,
  normalizeNovaModelId,
} from "./calculateRequestCost";

/**
 * Amazon Nova on Bedrock, from the AWS Price List API (offer AmazonBedrock,
 * us-east-1 on-demand, read 2026-11-08): Nova 2 Lite $0.33 / $2.75, Nova Pro
 * $0.80 / $3.20, Nova Lite $0.06 / $0.24 and Nova Micro $0.035 / $0.14 per
 * MTok. A cache read is a quarter of the input price and a cache write $0.00
 * (the written tokens are billed as input). The Price List has no regional
 * premium for Nova, so a `us.` profile and a bare ID price the same.
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

  it("names exactly the models that take cache points and have a price", () => {
    for (const id of [
      "amazon.nova-2-lite-v1:0",
      "amazon.nova-pro-v1:0",
      "amazon.nova-lite-v1:0",
      "amazon.nova-micro-v1:0",
      "amazon.nova-premier-v1:0",
      "us.amazon.nova-2-pro-v1:0",
    ]) {
      const named = normalizeNovaModelId(id) !== undefined;
      expect(named).toBe(bedrockCachePointFields(id) !== undefined);
      expect(named).toBe(findNovaPricing(id) !== null);
    }
  });
});

describe("Nova list prices", () => {
  it.each([
    ["amazon.nova-2-lite-v1:0", 0.33, 2.75],
    ["amazon.nova-pro-v1:0", 0.8, 3.2],
    ["amazon.nova-lite-v1:0", 0.06, 0.24],
    ["amazon.nova-micro-v1:0", 0.035, 0.14],
  ])(
    "%s: $%s in, $%s out, read a quarter, write nothing",
    (id, input, output) => {
      const p = findNovaPricing(id)!;
      expect(p.input).toBe(input);
      expect(p.output).toBe(output);
      expect(p.cacheRead).toBeCloseTo(input / 4, 9);
      expect(p.cacheWrite).toBe(0);
      expect(p.cacheWrite1h).toBe(0);
      expect(p.longContext).toBeUndefined();
    },
  );

  it("is what findModelPricing returns, so the chat window prices Nova too", () => {
    expect(findModelPricing("amazon.nova-2-lite-v1:0")).toEqual(
      findNovaPricing("amazon.nova-2-lite-v1:0"),
    );
    expect(findModelPricing("global.amazon.nova-2-lite-v1:0")).toEqual(
      findNovaPricing("amazon.nova-2-lite-v1:0"),
    );
    expect(findModelPricing("amazon.nova-premier-v1:0")).toBeNull();
  });
});

describe("Nova has no regional premium", () => {
  it.each([
    "us.amazon.nova-2-lite-v1:0",
    "eu.amazon.nova-2-lite-v1:0",
    "apac.amazon.nova-2-lite-v1:0",
    "global.amazon.nova-2-lite-v1:0",
    "amazon.nova-2-lite-v1:0",
    "us.amazon.nova-pro-v1:0",
    "us.amazon.nova-premier-v1:0",
  ])("%s has factor 1", (id) => {
    expect(bedrockRegionalPriceFactor(id)).toBe(1);
  });

  it("prices a us. profile at the same in-region rate", () => {
    const p = findModelPricing("us.amazon.nova-2-lite-v1:0")!;
    expect(p.input).toBe(0.33);
    expect(p.output).toBe(2.75);
    expect(p.cacheWrite).toBe(0);
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
      (101 / MTOK) * 0.33 + (400 / MTOK) * 2.75 + (3022 / MTOK) * 0.0825;
    expect(r.cost).toBeCloseTo(expected, 9);
    expect(r.breakdown).toContain("Cache Read: 3,022 tokens × $0.0825/MTok");
    expect(r.breakdown).toContain(
      "Prices: AWS Price List, us-east-1 on-demand (Amazon Nova)",
    );
  });

  it("prices a cache write at nothing beyond the input it was counted in", () => {
    const usage: Usage = {
      promptTokens: 3123,
      completionTokens: 0,
      promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 3123 },
    };
    const r = calculateRequestCost(
      "bedrock",
      "amazon.nova-2-lite-v1:0",
      usage,
    )!;
    expect(r.cost).toBeCloseTo((3123 / MTOK) * 0.33, 9);
    expect(r.breakdown).toContain("Cache Write (5m): 3,123 tokens × $0/MTok");
  });

  it("prices a us. profile at the in-region rate, with no factor line", () => {
    const usage: Usage = { promptTokens: MTOK, completionTokens: 0 };
    const us = calculateRequestCost(
      "bedrock",
      "us.amazon.nova-2-lite-v1:0",
      usage,
    )!;
    expect(us.cost).toBeCloseTo(0.33, 9);
    expect(us.breakdown).not.toContain("Bedrock regional endpoint");
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
