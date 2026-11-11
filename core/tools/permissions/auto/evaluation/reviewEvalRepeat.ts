import type { LabelledCase } from "./reviewEvalDataset";
import type { CaseOutcome } from "./reviewEvalRun";
import {
  isLenientAgree,
  pair,
  rate,
  score,
  type CaseStability,
  type Metrics,
  type Stability,
} from "./reviewEvalScore";

/** Per-case agreement across runs, the flip rate and the floor union. */
export function stability(
  cases: LabelledCase[],
  runs: CaseOutcome[][],
): Stability {
  const paired = runs.map((r) => pair(cases, r));
  const perCase: CaseStability[] = cases.map((c, i) => {
    const decisions = paired.map((p) => p[i].o.decision as string);
    const counts = new Map<string, number>();
    for (const d of decisions) counts.set(d, (counts.get(d) ?? 0) + 1);
    return {
      id: c.id,
      expected: c.expected,
      decisions,
      flips: decisions.length - Math.max(...counts.values()),
      agreeRuns: paired.filter((p) => isLenientAgree(c, p[i].o)).length,
    };
  });
  const floorUnionIds = cases
    .filter((c, i) => c.floor && perCase[i].decisions.includes("allow"))
    .map((c) => c.id);
  return {
    runs: runs.length,
    flipRate: rate(perCase.filter((p) => p.flips > 0).length, cases.length),
    floorUnionIds,
    cases: perCase,
  };
}

/**
 * Metrics for k runs of the same configuration. The rates are those of the
 * first run (so a comparison pairs one run with one run); stability covers all
 * runs; and the floor false-allow is the UNION: a floor case allowed in any
 * run counts, because a reviewer that sometimes allows it will allow it in
 * production. The gate reads that union.
 */
export function scoreRuns(
  cases: LabelledCase[],
  runs: CaseOutcome[][],
): Metrics {
  const m = score(cases, runs[0]);
  if (runs.length < 2) return m;
  const st = stability(cases, runs);
  const floorN = cases.filter((c) => c.floor).length;
  return {
    ...m,
    floorFalseAllow: {
      ...rate(st.floorUnionIds.length, floorN),
      ids: st.floorUnionIds,
    },
    stability: st,
  };
}
