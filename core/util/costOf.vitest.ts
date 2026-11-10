import { describe, expect, it } from "vitest";
import { addCost, costOf, formatCostAmount } from "./costOf";

const sonnet = { provider: "anthropic", model: "claude-sonnet-4-6" };

describe("costOf", () => {
  it("prices each kind of token at its own rate", () => {
    // Sonnet 4.6: $3 in, $15 out, 5m write 3.75, read 0.30 per MTok
    const r = costOf(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      },
      sonnet,
    );
    expect(r.amount).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
    expect(r.breakdown.join("\n")).toContain("Cache Read");
    expect(r.assumptions.join("\n")).toContain("standard tier");
    expect(r.assumptions.join("\n")).toContain("5-minute");
  });

  it("splits cache writes by lifetime when told, and drops the 5-minute assumption", () => {
    const r = costOf(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 2_000_000,
        cacheWrite1h: 1_000_000,
      },
      sonnet,
    );
    // 1M at 3.75 plus 1M at 6
    expect(r.amount).toBeCloseTo(9.75, 6);
    expect(r.assumptions.join("\n")).not.toContain("5-minute");
  });

  it("prices the new Fable 5.2 row", () => {
    const r = costOf(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      },
      { provider: "anthropic", model: "claude-fable-5-2" },
    );
    expect(r.amount).toBeCloseTo(8 + 40 + 0.2, 6);
  });

  it("applies the Bedrock regional premium and says where it came from", () => {
    const r = costOf(
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { provider: "bedrock", model: "us.anthropic.claude-sonnet-4-6" },
    );
    expect(r.amount).toBeCloseTo(3.3, 6);
    expect(r.assumptions.join("\n")).toContain("regional");
  });

  it("treats OpenAI input as including the cached part", () => {
    // gpt-5: $1.25 in, $0.125 cached, $10 out. Fresh 1M + cached 1M + 1M out
    const r = costOf(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      },
      { provider: "openai", model: "gpt-5" },
    );
    expect(r.amount).toBeCloseTo(1.25 + 0.125 + 10, 6);
  });

  it("is unknown, not zero, for a model with no price", () => {
    for (const model of [
      { provider: "ollama", model: "qwen3-coder:30b" },
      { provider: "anthropic", model: "claude-opus-9" },
      { provider: "openai", model: "gpt-4.1-nano" },
    ]) {
      const r = costOf(
        { input: 5_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
        model,
      );
      expect(r.amount).toBe("unknown");
      expect(r.breakdown[0]).toContain("cost unknown for this model");
    }
  });

  it("is unknown for an OpenAI request over the long-context limit", () => {
    const r = costOf(
      { input: 300_000, output: 10, cacheRead: 0, cacheWrite: 0 },
      { provider: "openai", model: "gpt-5.5" },
    );
    expect(r.amount).toBe("unknown");
  });

  it("takes a price the person entered, zero included, for a local model", () => {
    const local = { provider: "ollama", model: "llama3" };
    const usage = {
      input: 2_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    };
    expect(
      costOf(usage, local, { userPrice: { input: 0, output: 0 } }).amount,
    ).toBe(0);
    const paid = costOf(usage, local, { userPrice: { input: 0.5, output: 2 } });
    expect(paid.amount).toBeCloseTo(3, 6);
    expect(paid.assumptions[0]).toContain("you entered");
  });

  it("prices a long-context tier per request, not on the total", () => {
    const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
    // Ten requests of 50K input each: 500K in all, but none over 100K
    const small = costOf(
      { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 10 },
      haiku,
    );
    expect(small.amount).toBeCloseTo(0.5 * 0.1, 6);
    // The same total in one request is over the limit: $0.50 per MTok
    const big = costOf(
      { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 },
      haiku,
    );
    expect(big.amount).toBeCloseTo(0.5 * 0.5, 6);
    expect(small.assumptions.join("\n")).toContain("average");
  });

  it("ignores negative and non-finite counts", () => {
    const r = costOf(
      { input: -5, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
      sonnet,
    );
    expect(r.amount).toBe(0);
  });
});

describe("addCost and formatCostAmount", () => {
  it("never turns unknown into a number", () => {
    expect(addCost(1, 2)).toBe(3);
    expect(addCost(1, "unknown")).toBe("unknown");
    expect(addCost("unknown", 0)).toBe("unknown");
  });

  it("formats", () => {
    expect(formatCostAmount(1.839)).toBe("$1.84");
    expect(formatCostAmount(0.0042)).toBe("$0.0042");
    expect(formatCostAmount(0)).toBe("$0");
    expect(formatCostAmount("unknown")).toBe("cost unknown");
  });
});
