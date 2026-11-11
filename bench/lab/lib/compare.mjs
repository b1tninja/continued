// `compare`: two result sets (two engines, or two configurations of one
// engine) paired by case id and pass index. Pure functions of the records.
//
// Each case is a paired binary outcome (valid call or not), so the test is
// McNemar's exact test on the discordant pairs: under no difference a
// discordant pair is equally likely to favour either arm, so the smaller of
// the two discordant counts is Binomial(b + c, 1/2). Concordant pairs carry
// no information about which arm is better and are only counted.
// Under MIN_PAIRS pairs the report refuses a verdict (bench/README.md sample
// size section: about 25 runs per arm for a 0.3 difference).
import { armOf } from "./report.mjs";
import { fmtRate, wilson } from "./stats.mjs";

export const MIN_PAIRS = 25;

export class CompareError extends Error {}

/** log of n choose k, by summation (n is small: the discordant count). */
const logChoose = (n, k) => {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
};

/** Two-sided exact McNemar p-value for discordant counts b and c. */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let p = 0;
  for (let k = 0; k <= lo; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** Small seeded PRNG (mulberry32): the bootstrap interval is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile interval for (rate B - rate A), resampling PAIRS so the pairing
 * is kept. `diffs` is +1 (B only valid), -1 (A only valid) or 0 per pair.
 */
export function pairedBootstrap(diffs, { reps = 2000, seed = 1 } = {}) {
  const n = diffs.length;
  if (n === 0) return undefined;
  const rnd = prng(seed);
  const means = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return {
    lo: means[Math.floor(0.025 * reps)],
    hi: means[Math.min(reps - 1, Math.ceil(0.975 * reps) - 1)],
  };
}

/** The pairing key: what was asked, not who answered. */
export const pairKey = (r) =>
  [r.suite, armOf(r), r.caseId ?? r.key, r.pass ?? 1].join("\u0000");

/** Records for the comparison: not the cache suite, one model. */
function side(records, model, label) {
  const scored = records.filter((r) => r.kind !== "cache");
  const models = [...new Set(scored.map((r) => r.model))];
  if (model) {
    const keep = scored.filter((r) => r.model === model);
    if (!keep.length)
      throw new CompareError(
        `${label}: no records for model ${model} (have ${models.join(", ") || "none"})`,
      );
    return { all: keep, models: [model] };
  }
  if (models.length > 1)
    throw new CompareError(
      `${label} holds ${models.length} models (${models.join(", ")}); pick one with --model-${label.toLowerCase()}`,
    );
  return { all: scored, models };
}

/**
 * Pair two record sets. Returns counts, per-arm rates, discordant counts,
 * the exact McNemar p-value, the bootstrap interval, the flipped cases and
 * the verdict.
 */
export function compareRuns(recsA, recsB, opts = {}) {
  const A = side(recsA, opts.modelA, "A");
  const B = side(recsB, opts.modelB, "B");
  const index = (rs) => {
    const m = new Map();
    let errors = 0;
    let duplicates = 0;
    for (const r of rs) {
      if (r.outcome === "error") {
        errors++;
        continue;
      }
      if (!r.score) continue;
      const k = pairKey(r);
      if (m.has(k)) duplicates++;
      else m.set(k, r);
    }
    return { m, errors, duplicates };
  };
  const ia = index(A.all);
  const ib = index(B.all);
  const pairs = [];
  for (const [k, ra] of ia.m) {
    const rb = ib.m.get(k);
    if (rb) pairs.push({ key: k, a: ra, b: rb });
  }
  const va = pairs.filter((p) => p.a.score.valid).length;
  const vb = pairs.filter((p) => p.b.score.valid).length;
  const onlyA = pairs.filter((p) => p.a.score.valid && !p.b.score.valid);
  const onlyB = pairs.filter((p) => !p.a.score.valid && p.b.score.valid);
  const n = pairs.length;
  const p = mcnemarExact(onlyA.length, onlyB.length);
  const diffs = pairs.map(
    (x) => Number(x.b.score.valid) - Number(x.a.score.valid),
  );
  const flipped = [...onlyA, ...onlyB].map((x) => ({
    case: x.a.caseId ?? x.key,
    arm: armOf(x.a),
    pass: x.a.pass,
    from: x.a.score.valid,
    to: x.b.score.valid,
    outcomeA: x.a.outcome,
    outcomeB: x.b.outcome,
  }));
  const enough = n >= MIN_PAIRS;
  const disc = onlyA.length + onlyB.length;
  let verdict;
  if (!enough)
    verdict = `NOT ENOUGH PAIRS: ${n} paired result(s), at least ${MIN_PAIRS} are needed for a claim about a 0.3 difference (bench/README.md, sample size). Report the rates, make no statement about which arm is ahead.`;
  else if (p < 0.05)
    verdict = `${vb > va ? "B" : "A"} is better: exact McNemar p = ${p.toFixed(4)} on ${disc} discordant pair(s).`;
  else
    verdict = `No detectable difference: exact McNemar p = ${p.toFixed(4)} on ${disc} discordant pair(s). This is not evidence that the arms are equal.`;
  return {
    pairs: n,
    enough,
    rateA: wilson(va, n),
    rateB: wilson(vb, n),
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    both: pairs.filter((x) => x.a.score.valid && x.b.score.valid).length,
    neither: pairs.filter((x) => !x.a.score.valid && !x.b.score.valid).length,
    p,
    delta: n ? (vb - va) / n : undefined,
    bootstrap: pairedBootstrap(diffs, opts.bootstrap),
    flipped,
    unpaired: { a: ia.m.size - n, b: ib.m.size - n },
    errors: { a: ia.errors, b: ib.errors },
    duplicates: { a: ia.duplicates, b: ib.duplicates },
    models: { a: A.models[0], b: B.models[0] },
    verdict,
  };
}

const pts = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pts`;

export function formatCompare(res, labels = ["A", "B"]) {
  const [la, lb] = labels;
  const L = [
    `# Lab compare: ${la} vs ${lb}`,
    "",
    `**Verdict:** ${res.verdict}`,
    "",
    `Arms: A = ${la}${res.models.a ? ` (${res.models.a})` : ""}, B = ${lb}${res.models.b ? ` (${res.models.b})` : ""}. Pairs are matched on suite, arm, case id and pass index; ${res.pairs} paired.`,
    "",
    "| arm | valid-call rate on the pairs (Wilson 95%) |",
    "| --- | --- |",
    `| A ${la} | ${fmtRate(res.rateA)} |`,
    `| B ${lb} | ${fmtRate(res.rateB)} |`,
    "",
  ];
  if (res.pairs) {
    L.push(
      `Difference B - A: ${pts(res.delta)}${res.bootstrap ? `, paired bootstrap 95% interval [${pts(res.bootstrap.lo)}, ${pts(res.bootstrap.hi)}]` : ""}.`,
      "",
      "| | B valid | B invalid |",
      "| --- | ---: | ---: |",
      `| **A valid** | ${res.both} | ${res.onlyA} |`,
      `| **A invalid** | ${res.onlyB} | ${res.neither} |`,
      "",
      `McNemar exact (two-sided) on the discordant pairs ${res.onlyA} and ${res.onlyB}: p = ${res.p.toFixed(4)}.`,
      "",
    );
  }
  L.push(`## Cases that flipped (${res.flipped.length})`, "");
  for (const f of res.flipped)
    L.push(
      `- ${f.case} [${f.arm}] pass ${f.pass}: A ${f.from ? "valid" : "invalid"} (${f.outcomeA}), B ${f.to ? "valid" : "invalid"} (${f.outcomeB})`,
    );
  if (!res.flipped.length) L.push("None.");
  const notes = [];
  if (res.unpaired.a || res.unpaired.b)
    notes.push(
      `Not paired (present on one side only): ${res.unpaired.a} in A, ${res.unpaired.b} in B.`,
    );
  if (res.errors.a || res.errors.b)
    notes.push(
      `Errors left out of the pairs: ${res.errors.a} in A, ${res.errors.b} in B.`,
    );
  if (res.duplicates.a || res.duplicates.b)
    notes.push(
      `Duplicate keys ignored (first kept): ${res.duplicates.a} in A, ${res.duplicates.b} in B.`,
    );
  L.push(
    "",
    ...notes,
    "",
    "Both arms are measured on the same cases, so only discordant pairs say which is better. Token counts differ between engines: compare validity, not token or cache counters.",
  );
  return L.join("\n") + "\n";
}
