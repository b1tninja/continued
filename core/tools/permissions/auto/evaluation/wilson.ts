/**
 * Wilson score interval for k successes in n trials (same maths as
 * bench/src/wilson.mjs). The plain "k of n" percentage hides how little a
 * small sample says: 0 of 60 is an upper bound near 6%, not 0%.
 * z is 1.96 for a 95% interval. Returns null when n is 0.
 */
export function wilson(
  k: number,
  n: number,
  z = 1.96,
): { low: number; high: number } | null {
  if (!(n > 0)) return null;
  if (!(k >= 0 && k <= n)) throw new RangeError(`k=${k} is outside 0..${n}`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/**
 * Two-sided exact sign test on discordant pairs: the probability of a split at
 * least as lopsided as `a` versus `b` if each flip were a fair coin. It is
 * deliberately blunt; with few flips it almost never reaches significance.
 */
export function signTestP(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.min(a, b);
  // P(X <= k) for X ~ Binomial(n, 1/2), with logs to stay finite.
  let logC = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logC - n * Math.LN2);
    logC += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * tail);
}
