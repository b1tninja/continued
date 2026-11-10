import {
  detectStuck,
  STUCK_THRESHOLDS,
  type StuckLevel,
  type StuckSignalKind,
  type StuckStep,
} from "./stuckSignals.js";

/**
 * Measuring the stuck signals on recorded histories (plans/stuck-detection.md,
 * S1). Pure: it takes histories already turned into steps (stuckHistory.ts)
 * and reports, per signal, how often it fired and how early. It changes no
 * threshold; it is the evidence a person sets them from.
 */

/** What a person knows about a recorded run, when they know it. */
export type RunLabel = "healthy" | "stuck" | "unlabeled";

export interface MeasuredRun {
  id: string;
  label?: RunLabel;
  steps: StuckStep[];
}

export const SIGNAL_KINDS: StuckSignalKind[] = [
  "repeat-call",
  "near-repeat",
  "repeat-error",
  "ping-pong",
  "edit-revert",
  "no-progress",
  "monologue",
  "retry-after-fail",
];

/** The plan's bar: a signal that fires on more than this share of healthy runs is dropped or tightened. */
export const HEALTHY_FIRE_LIMIT = 0.05;

/** When, in one run, a signal or the overall level was first reached. */
export interface RunFirst {
  /** 1-based step at which `note` was first reached */
  note?: number;
  /** 1-based step at which `stuck` was first reached */
  stuck?: number;
}

export interface RunMeasure {
  id: string;
  label: RunLabel;
  steps: number;
  /** First step each signal reached each level */
  signals: Partial<Record<StuckSignalKind, RunFirst>>;
  /** First step the overall report reached each level */
  overall: RunFirst;
}

/**
 * Runs the signals over every prefix of the run, as a live session would see
 * them, and records the first step each one fired. Quadratic in the steps.
 */
export function measureRun(run: MeasuredRun): RunMeasure {
  const out: RunMeasure = {
    id: run.id,
    label: run.label ?? "unlabeled",
    steps: run.steps.length,
    signals: {},
    overall: {},
  };
  const mark = (first: RunFirst, level: StuckLevel, at: number) => {
    if (level === "none") return;
    first.note ??= at;
    if (level === "stuck") first.stuck ??= at;
  };
  for (let i = 1; i <= run.steps.length; i++) {
    const report = detectStuck(run.steps.slice(0, i));
    mark(out.overall, report.level, i);
    for (const s of report.signals) {
      mark((out.signals[s.kind] ??= {}), s.level, i);
    }
  }
  return out;
}

export interface Rate {
  fired: number;
  of: number;
  /** fired / of, or 0 for an empty group */
  rate: number;
}

function rate(fired: number, of: number): Rate {
  return { fired, of, rate: of === 0 ? 0 : fired / of };
}

export interface SignalRow {
  kind: StuckSignalKind | "overall";
  /** Runs where it reached `note` / `stuck`, over all runs */
  note: Rate;
  stuck: Rate;
  /** The same over the runs labelled healthy and stuck */
  healthyNote: Rate;
  healthyStuck: Rate;
  stuckStuck: Rate;
  /**
   * Mean share of the run still to come when `stuck` first fired, in the
   * runs it fired in: 0.5 means half the run was left. The lead time, in the
   * unit of steps, before the run ended or its budget ran out.
   */
  meanLeadShare?: number;
  /** Mean steps still to come at that point */
  meanLeadSteps?: number;
  /** Fires on more than HEALTHY_FIRE_LIMIT of healthy runs at `stuck` (needs a labelled sample) */
  overHealthyLimit: boolean;
}

export interface Measurement {
  runs: number;
  healthy: number;
  stuck: number;
  unlabeled: number;
  rows: SignalRow[];
  thresholds: typeof STUCK_THRESHOLDS;
}

function row(kind: SignalRow["kind"], measures: RunMeasure[]): SignalRow {
  const first = (m: RunMeasure): RunFirst | undefined =>
    kind === "overall" ? m.overall : m.signals[kind];
  const healthy = measures.filter((m) => m.label === "healthy");
  const stuck = measures.filter((m) => m.label === "stuck");
  const count = (ms: RunMeasure[], level: keyof RunFirst) =>
    ms.filter((m) => first(m)?.[level] !== undefined).length;

  const leads = measures.flatMap((m) => {
    const at = first(m)?.stuck;
    return at === undefined ? [] : [{ left: m.steps - at, steps: m.steps }];
  });
  const healthyStuck = rate(count(healthy, "stuck"), healthy.length);
  return {
    kind,
    note: rate(count(measures, "note"), measures.length),
    stuck: rate(count(measures, "stuck"), measures.length),
    healthyNote: rate(count(healthy, "note"), healthy.length),
    healthyStuck,
    stuckStuck: rate(count(stuck, "stuck"), stuck.length),
    meanLeadShare:
      leads.length === 0
        ? undefined
        : leads.reduce((a, l) => a + l.left / l.steps, 0) / leads.length,
    meanLeadSteps:
      leads.length === 0
        ? undefined
        : leads.reduce((a, l) => a + l.left, 0) / leads.length,
    overHealthyLimit:
      healthy.length > 0 && healthyStuck.rate > HEALTHY_FIRE_LIMIT,
  };
}

/** Fire rates per signal, over a set of measured runs. */
export function summarize(measures: RunMeasure[]): Measurement {
  return {
    runs: measures.length,
    healthy: measures.filter((m) => m.label === "healthy").length,
    stuck: measures.filter((m) => m.label === "stuck").length,
    unlabeled: measures.filter((m) => m.label === "unlabeled").length,
    rows: [...SIGNAL_KINDS, "overall" as const].map((k) => row(k, measures)),
    thresholds: STUCK_THRESHOLDS,
  };
}

/** Measures runs and summarises them. */
export function measureRuns(runs: MeasuredRun[]): Measurement {
  return summarize(runs.map(measureRun));
}

const pct = (r: Rate) =>
  r.of === 0 ? "-" : `${(r.rate * 100).toFixed(1)}% (${r.fired}/${r.of})`;

/** A markdown table per the plan's S1 row: one line per signal. */
export function formatMeasurement(m: Measurement): string {
  const lines = [
    `Runs: ${m.runs} (healthy ${m.healthy}, stuck ${m.stuck}, unlabeled ${m.unlabeled})`,
    "",
    "| signal | note | stuck | healthy note | healthy stuck | stuck-run stuck | lead (steps) | lead (share) | over 5% |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of m.rows) {
    lines.push(
      `| ${r.kind} | ${pct(r.note)} | ${pct(r.stuck)} | ${pct(r.healthyNote)} | ${pct(r.healthyStuck)} | ${pct(r.stuckStuck)} | ${
        r.meanLeadSteps === undefined ? "-" : r.meanLeadSteps.toFixed(1)
      } | ${
        r.meanLeadShare === undefined
          ? "-"
          : `${(r.meanLeadShare * 100).toFixed(0)}%`
      } | ${r.overHealthyLimit ? "yes" : "no"} |`,
    );
  }
  lines.push("", `Thresholds: ${JSON.stringify(m.thresholds)}`);
  return lines.join("\n");
}
