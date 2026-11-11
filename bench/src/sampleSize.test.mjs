// node --test bench/src/sampleSize.test.mjs
// The exact numbers are checked against two independent methods: an exact
// BigInt hypergeometric for the p-values, and a seeded Monte Carlo for the
// power and the sequential error rates. No network, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCH_ALPHA,
  OBSERVED_RATES,
  SEQUENTIAL_DESIGNS,
  bonferroniAlphaLook,
  exactPower,
  fisherOneSided,
  nContinuous,
  nForZeroEvents,
  normalQuantile,
  ratePair,
  requiredN,
  sequentialOutcome,
  sequentialTypeI,
  wilsonWidth,
  worstCaseTable,
  zeroEventUpperBound,
} from "./sampleSize.mjs";

// --- independent p-value: exact integer arithmetic, no logs -----------------
const memoChoose = new Map();
function choose(n, r) {
  const key = `${n},${r}`;
  if (memoChoose.has(key)) return memoChoose.get(key);
  let v = 1n;
  for (let i = 1n; i <= BigInt(r); i++) {
    v = (v * (BigInt(n) - BigInt(r) + i)) / i;
  }
  memoChoose.set(key, v);
  return v;
}
const pMemo = new Map();
function bigP(a, n, c) {
  const key = `${a},${n},${c}`;
  if (pMemo.has(key)) return pMemo.get(key);
  const k = a + c;
  let num = 0n;
  for (let x = a; x <= Math.min(n, k); x++) {
    if (k - x > n) continue;
    num += choose(n, x) * choose(n, k - x);
  }
  const den = choose(2 * n, k);
  const v = Number((num * 10n ** 15n) / den) / 1e15;
  pMemo.set(key, v);
  return v;
}

// --- seeded Monte Carlo ------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const draw = (rng, n, p) => {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
};
function mcPower(n, pc, pt, reps, seed) {
  const rng = mulberry32(seed);
  let hit = 0;
  for (let r = 0; r < reps; r++) {
    const a = draw(rng, n, pt);
    const c = draw(rng, n, pc);
    if (bigP(a, n, c) <= BENCH_ALPHA + 1e-9) hit++;
  }
  return hit / reps;
}
function mcSequential(looks, alphaLook, pc, pt, reps, seed) {
  const rng = mulberry32(seed);
  let calls = 0;
  let used = 0;
  for (let r = 0; r < reps; r++) {
    let a = 0;
    let c = 0;
    let prev = 0;
    let called = false;
    for (const n of looks) {
      a += draw(rng, n - prev, pt);
      c += draw(rng, n - prev, pc);
      prev = n;
      if (bigP(a, n, c) <= alphaLook + 1e-9) {
        called = true;
        break;
      }
    }
    if (called) calls++;
    used += prev;
  }
  return { calls: calls / reps, expectedN: used / reps };
}

test("one-sided Fisher agrees with exact integer arithmetic and the plan examples", () => {
  for (let n = 1; n <= 25; n++) {
    for (let a = 0; a <= n; a++) {
      for (let c = 0; c <= n; c += 3) {
        assert.ok(
          Math.abs(fisherOneSided(a, n, c, n) - bigP(a, n, c)) < 1e-9,
          `${a}/${n} against ${c}/${n}`,
        );
      }
    }
  }
  // plans/stuck-calibration.md section 6
  assert.ok(Math.abs(fisherOneSided(8, 10, 3, 10) - 0.035) < 0.002);
  assert.ok(fisherOneSided(8, 10, 3, 10) <= BENCH_ALPHA);
  assert.ok(fisherOneSided(7, 10, 4, 10) > BENCH_ALPHA);
});

test("exact power matches a seeded Monte Carlo", () => {
  const cases = [
    [5, 0.1, 0.9],
    [10, 0.3, 0.6],
    [10, 0.2, 0.7],
    [20, 0.3, 0.6],
    [29, 0.3, 0.6],
    [13, 0.2, 0.7],
  ];
  cases.forEach(([n, pc, pt], i) => {
    const exact = exactPower(n, pc, pt);
    const mc = mcPower(n, pc, pt, 40000, 1000 + i);
    // 40000 runs: the standard error is at most 0.0025; allow five of them
    assert.ok(
      Math.abs(exact - mc) < 0.0125,
      `n=${n} ${pc}->${pt}: exact ${exact} mc ${mc}`,
    );
  });
});

test("the test is conservative: the true type I error never exceeds alpha", () => {
  for (const n of [3, 5, 8, 10, 15, 20, 30]) {
    for (const p of [0.05, 0.2, 0.5, 0.8]) {
      assert.ok(exactPower(n, p, p) <= BENCH_ALPHA + 1e-9, `n=${n} p=${p}`);
    }
  }
});

test("power rises with the difference and with n; n below 10 cannot show 0.3", () => {
  assert.ok(exactPower(10, 0.3, 0.8) > exactPower(10, 0.3, 0.6));
  assert.ok(exactPower(40, 0.3, 0.6) > exactPower(10, 0.3, 0.6));
  for (const n of [3, 5, 8]) assert.ok(exactPower(n, 0.3, 0.6) < 0.35);
});

test("requiredN reaches the target at n and stays there", () => {
  const r = requiredN(0.3, 0.6);
  assert.ok(exactPower(r.first, 0.3, 0.6) >= 0.8);
  assert.ok(exactPower(r.first - 1, 0.3, 0.6) < 0.8);
  for (let n = r.stable; n <= r.stable + 15; n++) {
    assert.ok(exactPower(n, 0.3, 0.6) >= 0.8, `n=${n}`);
  }
  assert.ok(r.stable >= r.first);
});

test("the numbers the README quotes", () => {
  assert.equal(requiredN(0.3, 0.6).stable, 29);
  assert.equal(requiredN(0.3, 0.5).stable, 65);
  const w = worstCaseTable();
  assert.equal(w[0.2].stable, 67);
  assert.equal(w[0.3].stable, 33);
  assert.equal(w[0.5].stable, 13);
  assert.equal(nForZeroEvents(0.05), 59);
  assert.equal(nForZeroEvents(0.1), 29);
});

test("ratePair puts the higher rate in the treatment slot", () => {
  assert.deepEqual(ratePair(0.3, 0.2), [0.3, 0.5]);
  const [lo, hi] = ratePair(4 / 6, 0.5);
  assert.ok(Math.abs(lo - 1 / 6) < 1e-12 && Math.abs(hi - 4 / 6) < 1e-12);
  assert.equal(ratePair(0.5, 0.6), null);
});

test("zero-event bound and Wilson widths", () => {
  assert.ok(Math.abs(zeroEventUpperBound(59) - 0.05) < 0.001);
  assert.ok(zeroEventUpperBound(3) > 0.6);
  const widths = [3, 5, 8, 10, 20, 40].map((n) => wilsonWidth(n));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1]);
  assert.ok(widths[0] > 0.7);
  assert.ok(wilsonWidth(10) > 0.5);
  assert.ok(wilsonWidth(40) < 0.31);
});

test("normal quantile and the continuous approximation", () => {
  assert.ok(Math.abs(normalQuantile(0.9) - 1.2816) < 0.001);
  assert.ok(Math.abs(normalQuantile(0.975) - 1.96) < 0.001);
  assert.equal(nContinuous(1, 1), 12);
  assert.ok(nContinuous(1, 0.5) > 3 * nContinuous(1, 1));
});

test("every observed rate cites a plan that exists", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  for (const r of OBSERVED_RATES) {
    const file = /^(plans\/[\w.-]+\.md)/.exec(r.source)?.[1];
    assert.ok(file && fs.existsSync(path.join(root, file)), r.metric);
    assert.ok(r.rate >= 0 && r.rate <= 1);
  }
});

test("sequential: the dynamic program matches a seeded Monte Carlo", () => {
  const { looks, alphaLook } = SEQUENTIAL_DESIGNS.small;
  const cases = [
    [0.5, 0.5],
    [0.3, 0.8],
    [0.3, 0.6],
  ];
  cases.forEach(([pc, pt], i) => {
    const exact = sequentialOutcome(looks, alphaLook, pc, pt);
    const mc = mcSequential(looks, alphaLook, pc, pt, 30000, 7000 + i);
    assert.ok(Math.abs(exact.calls - mc.calls) < 0.0135, `${pc}/${pt} calls`);
    assert.ok(Math.abs(exact.expectedN - mc.expectedN) < 0.2, `${pc}/${pt} n`);
  });
});

test("sequential designs keep the overall type I error within the bar", () => {
  for (const [name, d] of Object.entries(SEQUENTIAL_DESIGNS)) {
    const t = sequentialTypeI(d.looks, d.alphaLook);
    assert.ok(t.worst <= BENCH_ALPHA, `${name}: ${t.worst} at ${t.at}`);
    assert.equal(d.bonferroni, bonferroniAlphaLook(d.looks, BENCH_ALPHA));
    const b = sequentialTypeI(d.looks, d.bonferroni);
    assert.ok(b.worst <= BENCH_ALPHA, `${name} bonferroni: ${b.worst}`);
    const seq = sequentialOutcome(d.looks, d.alphaLook, 0.3, 0.8);
    assert.ok(seq.expectedN < d.looks.at(-1));
  }
});

test("peeking at the unadjusted alpha breaks the bar", () => {
  const { looks } = SEQUENTIAL_DESIGNS.large;
  assert.ok(sequentialTypeI(looks, BENCH_ALPHA).worst > 0.13);
});
