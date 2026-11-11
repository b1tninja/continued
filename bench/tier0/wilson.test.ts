import { describe, expect, it } from "vitest";

import { intervalOnly, rateWithInterval, wilson } from "../src/wilson.mjs";

/**
 * The Wilson 95% interval printed beside every rate the scorer reports.
 * Reference values are the standard published ones (Wilson 1927; for example
 * 1 of 8 is 2.2% to 47.1%).
 *
 * Run from extensions/cli: npx vitest run --dir ../../bench/tier0
 */
describe("wilson", () => {
  it.each([
    [1, 8, 0.0224, 0.4709],
    [2, 8, 0.0712, 0.5909],
    [0, 8, 0, 0.3244],
    [8, 8, 0.6756, 1],
    [5, 10, 0.2366, 0.7634],
    [50, 100, 0.4038, 0.5962],
  ])("%i of %i", (k, n, low, high) => {
    const ci = wilson(k, n)!;
    expect(ci.low).toBeCloseTo(low, 3);
    expect(ci.high).toBeCloseTo(high, 3);
  });

  it("stays inside 0..1 and brackets the observed rate", () => {
    for (let n = 1; n <= 30; n++) {
      for (let k = 0; k <= n; k++) {
        const ci = wilson(k, n)!;
        expect(ci.low).toBeGreaterThanOrEqual(0);
        expect(ci.high).toBeLessThanOrEqual(1);
        expect(ci.low).toBeLessThanOrEqual(k / n + 1e-12);
        expect(ci.high).toBeGreaterThanOrEqual(k / n - 1e-12);
      }
    }
  });

  it("narrows as the sample grows", () => {
    const small = wilson(5, 10)!;
    const big = wilson(500, 1000)!;
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });

  it("has no interval for no trials, and refuses an impossible count", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(9, 8)).toThrow(RangeError);
    expect(() => wilson(-1, 8)).toThrow(RangeError);
  });
});

describe("formatting", () => {
  it("prints the rate with its interval", () => {
    expect(rateWithInterval(1, 8)).toBe("13% (95% CI 2-47%)");
    expect(rateWithInterval(8, 8)).toBe("100% (95% CI 68-100%)");
    expect(rateWithInterval(0, 0)).toBe("n/a");
  });

  it("prints the interval alone", () => {
    expect(intervalOnly(2, 8)).toBe("95% CI 7-59%");
    expect(intervalOnly(0, 0)).toBe("n/a");
  });
});
