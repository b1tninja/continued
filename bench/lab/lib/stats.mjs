// Interval maths for the reports. Pure. Own copy of the Wilson interval so the
// lab needs nothing from the product (the product keeps its own in
// core/llm/toolDialects/capture/stats.ts and bench/src/wilson.mjs).
export const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials; whole range when n is 0. */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n)
    throw new RangeError(`wilson needs integers 0 <= k <= n, got ${k}/${n}`);
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

const pct = (x) => `${Math.round(x * 100)}%`;

/** "2/8 = 25% [7%, 59%]"; "0/0 = n/a" with no trials. */
export function fmtRate(r) {
  if (!r || r.n === 0) return "0/0 = n/a";
  return `${r.k}/${r.n} = ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
}

/** Whether two intervals are disjoint: the cheap "this moved" test. */
export function disjoint(a, b) {
  if (!a || !b || a.n === 0 || b.n === 0) return false;
  return a.hi < b.lo || b.hi < a.lo;
}

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const rate = (k, n) => wilson(k, n);
