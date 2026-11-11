// How many runs per arm the bench needs. Pure, dependency-free, no network;
// everything is exact (the binomial outcomes are enumerated), nothing is a
// normal approximation except `nContinuous`, which says so.
//
// The bar is the only significance bar in the repository: one-sided Fisher
// exact test, alpha 0.10, in `core/util/stuckExperiment.ts`
// (`STUCK_EXPERIMENT.fisherAlpha`, with `minLift` 0.30). The scorer itself
// decides nothing: it prints counts and flags a cell with fewer than 3 runs.
//
//   node bench/src/sampleSize.mjs        prints the tables the README quotes
import { fileURLToPath } from "url";

import { wilson } from "./wilson.mjs";

/** The bench's own alpha: `STUCK_EXPERIMENT.fisherAlpha`, one-sided. */
export const BENCH_ALPHA = 0.1;
export const POWER = 0.8;

const logFactTable = [0, 0];
function logFact(n) {
  for (let i = logFactTable.length; i <= n; i++) {
    logFactTable[i] = logFactTable[i - 1] + Math.log(i);
  }
  return logFactTable[n];
}
const logChoose = (n, r) => logFact(n) - logFact(r) - logFact(n - r);

/** Binomial pmf over 0..n. */
export function binomialPmf(n, p) {
  const out = new Array(n + 1).fill(0);
  if (p <= 0) {
    out[0] = 1;
    return out;
  }
  if (p >= 1) {
    out[n] = 1;
    return out;
  }
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  for (let k = 0; k <= n; k++) {
    out[k] = Math.exp(logChoose(n, k) + k * lp + (n - k) * lq);
  }
  return out;
}

/**
 * One-sided Fisher exact p: the chance of `a` or more successes in the first
 * group (n1 runs) when `a + c` successes fall among n1 + n2 runs by luck.
 * Same quantity as `fisherOneSided` in core/util/stuckExperiment.ts.
 */
export function fisherOneSided(a, n1, c, n2) {
  const k = a + c;
  const total = n1 + n2;
  let p = 0;
  for (let x = a; x <= Math.min(n1, k); x++) {
    if (k - x > n2) continue;
    p += Math.exp(
      logChoose(n1, x) + logChoose(n2, k - x) - logChoose(total, k),
    );
  }
  return Math.min(1, p);
}

/** Tolerance for comparing a p-value to alpha (a sum of logs is not exact). */
const EPS = 1e-9;

/**
 * For n runs per arm: for each total k = a + c, the smallest a in the
 * treatment arm that the one-sided test rejects at `alpha` (n + 1 when none).
 * p falls as a rises for a fixed k, so the region is a threshold per k.
 */
function rejectionThresholds(n, alpha) {
  const out = new Array(2 * n + 1);
  for (let k = 0; k <= 2 * n; k++) {
    let lo = Math.max(0, k - n);
    let hi = Math.min(n, k) + 1;
    // smallest a in lo..hi-1 with p <= alpha, else hi (then n + 1 below)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fisherOneSided(mid, n, k - mid, n) <= alpha + EPS) hi = mid;
      else lo = mid + 1;
    }
    out[k] = lo > Math.min(n, k) ? n + 1 : lo;
  }
  return out;
}

/**
 * Exact power: the chance that the one-sided Fisher test at `alpha` rejects
 * when the treatment arm's true rate is `pTreat` and the control's
 * `pControl`, n runs each. With the two rates equal this is the true type I
 * error, which is at most alpha and usually well under it (the test is
 * conservative at small n).
 */
export function exactPower(n, pControl, pTreat, alpha = BENCH_ALPHA) {
  const th = rejectionThresholds(n, alpha);
  const pt = binomialPmf(n, pTreat);
  const pc = binomialPmf(n, pControl);
  let power = 0;
  for (let a = 0; a <= n; a++) {
    for (let c = 0; c <= n; c++) {
      if (a >= th[a + c]) power += pt[a] * pc[c];
    }
  }
  return power;
}

/**
 * The pair [pControl, pTreat] for a difference of absolute size `d` that
 * starts from an observed rate `p`: p to p + d, or, when that would pass 1,
 * the pair (p - d, p) with p as the better arm. The one-sided test asks
 * whether the second arm is higher, and counting failures instead of
 * successes mirrors the pair, so this covers a leak rate falling as well as a
 * completion rate rising. Returns null when d fits neither way.
 */
export function ratePair(p, d) {
  if (p + d <= 1 + 1e-12) return [p, Math.min(1, p + d)];
  if (p - d >= -1e-12) return [Math.max(0, p - d), p];
  return null;
}

/**
 * Smallest n per arm whose exact power reaches `power` (`first`), and the
 * smallest n from which every n up to `maxN` also reaches it (`stable`).
 * Exact tests have a sawtooth power curve, so plan with `stable`. null when
 * no n up to maxN reaches it.
 */
export function requiredN(
  pControl,
  pTreat,
  { alpha = BENCH_ALPHA, power = POWER, maxN = 100 } = {},
) {
  let first = null;
  let stable = null;
  for (let n = 2; n <= maxN; n++) {
    const ok = exactPower(n, pControl, pTreat, alpha) >= power;
    if (ok && first === null) first = n;
    if (ok && stable === null) stable = n;
    if (!ok) stable = null;
  }
  return first === null || stable === null ? null : { first, stable };
}

/** Upper confidence bound on a rate when 0 events are seen in n runs. */
export function zeroEventUpperBound(n, confidence = 0.95) {
  return 1 - Math.pow(1 - confidence, 1 / n);
}

/** Event-free runs needed before the upper bound is <= maxRate. */
export function nForZeroEvents(maxRate, confidence = 0.95) {
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - maxRate));
}

/** Wilson interval width at n runs; k defaults to the middle (the widest). */
export function wilsonWidth(n, k = Math.round(n / 2)) {
  const ci = wilson(k, n);
  return ci.high - ci.low;
}

/** Standard normal quantile (Beasley-Springer-Moro). */
export function normalQuantile(p) {
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
  const b = [-8.4735109309, 23.08336743743, -21.06224101826, 3.13082909833];
  const c = [
    0.3374754822726147, 0.9761690190917186, 0.1607979714918209,
    0.0276438810333863, 0.0038405729373609, 0.0003951896511919,
    0.0000321767881768, 0.0000002888167364, 0.0000003960315187,
  ];
  const y = p - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    return (
      (y * (((a[3] * r + a[2]) * r + a[1]) * r + a[0])) /
      ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1)
    );
  }
  let r = y > 0 ? 1 - p : p;
  r = Math.log(-Math.log(r));
  let x = c[0];
  let pow = 1;
  for (let i = 1; i < 9; i++) {
    pow *= r;
    x += c[i] * pow;
  }
  return y > 0 ? x : -x;
}

/**
 * Runs per arm for a continuous per-run metric (cache read ratio, cost,
 * tokens, latency): the normal approximation for a one-sided two-sample test,
 * n = 2 ((z_alpha + z_power) sd / delta)^2, plus 2 runs for the t
 * distribution. An approximation, unlike the rest of this file; `sd` and
 * `delta` are in the metric's own unit.
 */
export function nContinuous(
  sd,
  delta,
  { alpha = BENCH_ALPHA, power = POWER } = {},
) {
  const z = normalQuantile(1 - alpha) + normalQuantile(power);
  return Math.ceil((2 * (z * sd) ** 2) / delta ** 2) + 2;
}

// ---------------------------------------------------------------------------
// Sequential stopping with pre-registered looks.
// ---------------------------------------------------------------------------

/**
 * Exact operating characteristics of: look at the cumulative counts after
 * `looks[i]` runs per arm (arms interleaved, equal n); stop and call the
 * treatment better the first time the one-sided Fisher p is <= alphaLook;
 * otherwise go on to the last look and stop with no call. Dynamic
 * programming over the (treatment, control) success counts, so it is exact.
 * Returns the chance of a call and the expected runs per arm.
 */
export function sequentialOutcome(looks, alphaLook, pControl, pTreat) {
  let state = new Map([["0,0", 1]]);
  let calls = 0;
  let expectedN = 0;
  let prev = 0;
  for (let li = 0; li < looks.length; li++) {
    const n = looks[li];
    const step = n - prev;
    const pt = binomialPmf(step, pTreat);
    const pc = binomialPmf(step, pControl);
    const next = new Map();
    for (const [key, mass] of state) {
      const [a0, c0] = key.split(",").map(Number);
      for (let da = 0; da <= step; da++) {
        for (let dc = 0; dc <= step; dc++) {
          const m = mass * pt[da] * pc[dc];
          if (m === 0) continue;
          const a = a0 + da;
          const c = c0 + dc;
          if (fisherOneSided(a, n, c, n) <= alphaLook + EPS) {
            calls += m;
            expectedN += m * n;
          } else if (li === looks.length - 1) {
            expectedN += m * n;
          } else {
            const k = `${a},${c}`;
            next.set(k, (next.get(k) ?? 0) + m);
          }
        }
      }
    }
    state = next;
    prev = n;
  }
  return { calls, expectedN };
}

/** Worst case over a grid of equal true rates of the chance of a call: the true type I error. */
export function sequentialTypeI(looks, alphaLook) {
  let worst = 0;
  let at = 0;
  for (let i = 1; i <= 19; i++) {
    const p = i / 20;
    const { calls } = sequentialOutcome(looks, alphaLook, p, p);
    if (calls > worst) {
      worst = calls;
      at = p;
    }
  }
  return { worst, at };
}

/**
 * The largest per-look alpha (on a 0.0025 grid) whose exact worst-case
 * overall type I error is still <= alpha: a Pocock-style constant boundary,
 * calibrated exactly for these counts instead of read from a normal table.
 */
export function pocockAlphaLook(looks, alpha = BENCH_ALPHA) {
  let best = 0;
  for (let a = 0.0025; a <= alpha + 1e-12; a += 0.0025) {
    if (sequentialTypeI(looks, a).worst <= alpha + 1e-12) best = a;
  }
  return best;
}

/** Bonferroni: alpha split equally over the looks. Conservative by the union bound. */
export const bonferroniAlphaLook = (looks, alpha = BENCH_ALPHA) =>
  alpha / looks.length;

/**
 * The pre-registered designs the README proposes. `alphaLook` is the Pocock
 * style constant calibrated by `pocockAlphaLook`; `bonferroni` is the plain
 * alpha / looks. Both were checked with `sequentialTypeI` (worst-case overall
 * type I error 0.098 and 0.095, at most 0.10) and by the tests' simulation.
 * Looks are runs per arm, arms interleaved. Changing a number after a run is
 * a new experiment.
 */
export const SEQUENTIAL_DESIGNS = {
  /** For differences of 0.5 and up: 20 runs per arm at most. */
  small: { looks: [5, 10, 15, 20], alphaLook: 0.0875, bonferroni: 0.025 },
  /** For differences of 0.3 and up: 40 runs per arm at most. */
  large: { looks: [10, 20, 30, 40], alphaLook: 0.0775, bonferroni: 0.025 },
};

// ---------------------------------------------------------------------------
// The rates actually seen in plans/ and the results, with where they come from.
// ---------------------------------------------------------------------------

export const OBSERVED_RATES = [
  {
    metric: "recovery, stuck-decoy control arm",
    kind: "completion",
    rate: 0.3,
    source:
      "plans/stuck-calibration.md section 6: 3 of 10 in its worked example; arm A must lie between 0.1 and 0.7",
  },
  {
    metric: "loop completion, Qwen3 Coder",
    kind: "completion",
    rate: 0.5,
    source:
      "plans/model-benchmark.md: 2 of 3 and 1 of 3 done across arms; 0.5 is the middle, at n=3",
  },
  {
    metric: "loop completion, Qwen3.8 flash",
    kind: "completion",
    rate: 5 / 12,
    source:
      "plans/model-benchmark.md: 7 of 12 loops ran into the budget, 5 of 12 done",
  },
  {
    metric: "text leak, 1 of 8",
    kind: "leak",
    rate: 1 / 8,
    source: "plans/live-capture.md: 1 of 8, Wilson 95% interval 2 to 47%",
  },
  {
    metric: "text leak, Qwen3-Coder runs",
    kind: "leak",
    rate: 8 / 24,
    source:
      "plans/tool-dialects.md: calls written as text in 8 of 24 runs (#370)",
  },
  {
    metric: "one-turn leak, full profile",
    kind: "leak",
    rate: 4 / 6,
    source: "plans/model-benchmark.md: 4 of 6 full-profile runs, 0 of 6 short",
  },
  {
    metric: "plan written as a text call, Nova short",
    kind: "leak",
    rate: 6 / 15,
    source:
      "plans/tool-dialects.md: 6 of 15 plan replies under short, 1 of 25 under full (#361)",
  },
  {
    metric: "finish nudge needed, Nova 2 Lite",
    kind: "compliance",
    rate: 6 / 18,
    source:
      "plans/model-benchmark.md: 6 of 18 attempts with the line, 6 of 15 without",
  },
  {
    metric: "plan-ask, reserved choice decided",
    kind: "compliance",
    rate: 2 / 3,
    source:
      "plans/model-benchmark.md principles: split 2 to 1 on Haiku 4.5 at n=3",
  },
  {
    metric: "false fire on healthy controls",
    kind: "false-fire",
    rate: 0.05,
    source: "plans/stuck-calibration.md section 6: the bar is at most 5%",
  },
];

/** The absolute differences the README table uses. */
export const EFFECTS = [0.2, 0.3, 0.5];

export function observedTable({ alpha = BENCH_ALPHA, power = POWER } = {}) {
  return OBSERVED_RATES.map((r) => {
    const cells = {};
    for (const d of EFFECTS) {
      const pair = ratePair(r.rate, d);
      cells[d] = pair ? requiredN(pair[0], pair[1], { alpha, power }) : null;
    }
    return { ...r, cells };
  });
}

/** The largest n over all baselines 0 to 1 (step 0.05) for each difference. */
export function worstCaseTable({ alpha = BENCH_ALPHA, power = POWER } = {}) {
  const out = {};
  for (const d of EFFECTS) {
    let worst = null;
    for (let i = 0; i <= 20; i++) {
      const pair = ratePair(i / 20, d);
      if (!pair) continue;
      const r = requiredN(pair[0], pair[1], { alpha, power });
      if (r && (!worst || r.stable > worst.stable)) {
        worst = { ...r, baseline: i / 20 };
      }
    }
    out[d] = worst;
  }
  return out;
}

const pct = (x) => `${(100 * x).toFixed(0)}%`;

function main() {
  console.log(
    `bar: one-sided Fisher exact, alpha ${BENCH_ALPHA}, power ${POWER}`,
  );
  console.log(`\nn per arm (stable; first in brackets) by observed baseline`);
  console.log(
    `| metric | rate | ${EFFECTS.map((d) => `d=${d}`).join(" | ")} |`,
  );
  for (const r of observedTable()) {
    const cells = EFFECTS.map((d) => {
      const c = r.cells[d];
      return c ? `${c.stable} [${c.first}]` : "n/a";
    });
    console.log(`| ${r.metric} | ${pct(r.rate)} | ${cells.join(" | ")} |`);
  }
  console.log("\nworst case over baselines");
  for (const [d, w] of Object.entries(worstCaseTable())) {
    console.log(
      `d=${d}: n=${w.stable} (first ${w.first}) at baseline ${w.baseline}`,
    );
  }
  console.log("\nWilson 95% width, p-hat 0.5 and 1 event");
  for (const n of [3, 5, 8, 10, 20, 40]) {
    console.log(
      `n=${n}: ${wilsonWidth(n).toFixed(2)} (mid), ${wilsonWidth(n, 1).toFixed(2)} (1 event)`,
    );
  }
  console.log("\nzero events: upper 95% bound");
  for (const n of [3, 5, 8, 10, 20, 40, 59]) {
    console.log(`n=${n}: ${pct(zeroEventUpperBound(n))}`);
  }
  console.log(
    `n for <=5%: ${nForZeroEvents(0.05)}, <=10%: ${nForZeroEvents(0.1)}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
