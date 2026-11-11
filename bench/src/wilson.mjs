/**
 * Wilson score interval for a rate seen as k successes in n trials. At the
 * sample sizes the bench runs (3 to 10 runs per arm) the plain "k of n"
 * percentage hides how little it says: 1 of 8 is 0.02 to 0.47, not 12.5.
 * Pure; z is 1.96 for a 95% interval.
 *
 * @param {number} k successes, 0 <= k <= n
 * @param {number} n trials
 * @param {number} [z]
 * @returns {{ low: number, high: number } | null} null when n is 0
 */
export function wilson(k, n, z = 1.96) {
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

const whole = (x) => `${Math.round(100 * x)}`;

/** "38% (95% CI 14-69%)", or "n/a" when there were no trials. */
export function rateWithInterval(k, n) {
  const ci = wilson(k, n);
  if (!ci) return "n/a";
  return `${whole(k / n)}% (95% CI ${whole(ci.low)}-${whole(ci.high)}%)`;
}

/** "95% CI 14-69%" alone, for a cell that already shows the count. */
export function intervalOnly(k, n) {
  const ci = wilson(k, n);
  return ci ? `95% CI ${whole(ci.low)}-${whole(ci.high)}%` : "n/a";
}
