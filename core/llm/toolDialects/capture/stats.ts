/** Interval maths for the live-capture report. Pure. */

export interface Rate {
  k: number;
  n: number;
  /** k / n, or 0 when n is 0. */
  rate: number;
  /** Wilson score interval bounds, 0..1. */
  lo: number;
  hi: number;
}

/** The two-sided 95 percent normal quantile. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval for k successes in n trials. Unlike the normal
 * approximation it stays inside 0..1 and is not zero-width at 0 or n, which
 * matters at the n of 3 to 96 a capture has. With n = 0 the interval is the
 * whole range.
 */
export function wilson(k: number, n: number, z: number = Z95): Rate {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilson needs integers 0 <= k <= n, got ${k}/${n}`);
  }
  if (n === 0) return { k, n, rate: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    rate: p,
    lo: Math.max(0, centre - margin),
    hi: Math.min(1, centre + margin),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** "2/8 = 25% [7%, 59%]". */
export function formatRate(r: Rate): string {
  if (r.n === 0) return "0/0 = n/a";
  return `${r.k}/${r.n} = ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
}
