import { buildWorkLog, formatWorkLog } from "./workLog";
import {
  type StuckReport,
  type StuckSignalKind,
  type StuckStep,
} from "./stuckSignals";

/**
 * The S3 experiment (plans/stuck-detection.md, plans/stuck-calibration.md): a
 * check-in against no check-in on a scenario the agent cannot solve the way it
 * starts. This file holds what must be fixed before any run: the design
 * constants and the pass bar, the check-in text of the treatment arm, and the
 * scorer that turns run records into a verdict. Nothing here calls a model and
 * nothing is wired into a host; the constants are the pre-registration, and
 * changing one after a run is a new experiment.
 */

/** The arms: the control and the treatment. */
export type ExperimentArm = "none" | "checkin";

/** The scenario the recovery metric is measured on (bench/scenarios). */
export const STUCK_SCENARIO = "stuck-decoy";

/** Healthy scenarios the treatment arm also runs, to count false alarms. */
export const HEALTHY_CONTROL_SCENARIOS = ["agent-acts", "loop-basic"] as const;

export const STUCK_EXPERIMENT = {
  /** Runs per arm, per model, on the stuck scenario */
  runsPerArm: 10,
  /** Models (a local and a hosted one); both must be present in the records */
  minModels: 2,
  /** Runs per healthy control scenario, under the treatment arm */
  controlRunsPerScenario: 10,
  /** Request budget of one run, the scenario's own budget */
  maxRequests: 40,
  /** Arm A's recovery rate must lie in this range, or the scenario is a floor or a ceiling */
  baselineRange: { min: 0.1, max: 0.7 },
  /** The treatment must beat the control by at least this, in recovery rate */
  minLift: 0.3,
  /** One-sided Fisher exact test, per model */
  fisherAlpha: 0.1,
  /** Median tokens of the treatment arm over the control arm's, at most */
  maxTokenRatio: 1.25,
  /** The check-in may fire on at most this share of healthy control runs */
  maxHealthyFire: 0.05,
  /** Steps without a signal after which a check-in may fire again */
  rearmAfterQuietSteps: 5,
  /** Lines of the work log a check-in carries */
  logLines: 12,
} as const;

// ----------------------------------------------------------------------
// The treatment

/**
 * The guidance line per signal, the plan's table. `card` is the toolbox card
 * the same advice comes from, so the person's chip and the agent's check-in
 * share one source (a test pins that the card exists).
 */
export const CHECK_IN_GUIDANCE: Record<
  StuckSignalKind,
  { card: string; line: string }
> = {
  "repeat-error": {
    card: "reproduce-first",
    line: "The same error keeps coming back. State in one sentence what you expect, what you see, and the smallest experiment that would tell them apart, then run that instead of another variation.",
  },
  "retry-after-fail": {
    card: "reproduce-first",
    line: "You have retried this command several times and it fails each time. Reproduce the failure in the smallest form before changing the command again.",
  },
  "ping-pong": {
    card: "trade-offs",
    line: "You are alternating between two states. List the two approaches and what each breaks, then pick one and say why.",
  },
  "edit-revert": {
    card: "trade-offs",
    line: "A file is back to content it had before. List what each version fixes and breaks, then pick one.",
  },
  "no-progress": {
    card: "restate-the-problem",
    line: "Nothing has changed and nothing new has been learned for several steps. Restate the goal in two sentences and name the next concrete step that is not a repeat.",
  },
  monologue: {
    card: "restate-the-problem",
    line: "You are restating the same plan without acting. Name the next concrete step and do it.",
  },
  "repeated-block": {
    card: "where-stuck",
    line: "These calls were refused or held for the person; trying again will get the same answer. Do not retry them: continue with work that needs no approval, or say what you are waiting for and stop.",
  },
  "persistent-failure": {
    card: "reproduce-first",
    line: "The same failure has survived several different edits, so the edits are not touching its cause. Reproduce it in the smallest form and find which file the failing code actually uses before editing again.",
  },
  "repeat-call": {
    card: "what-did-you-verify",
    line: "The last result of this call is above. What would be different now? If nothing, do not repeat it.",
  },
  "near-repeat": {
    card: "what-did-you-verify",
    line: "These calls differ only in spelling. The result will be the same; look for the assumption they share.",
  },
};

/** The signal the check-in is built around: the first `stuck` one, else the first. */
export function leadSignal(report: StuckReport) {
  return (
    report.signals.find((s) => s.level === "stuck") ?? report.signals.at(0)
  );
}

/**
 * The check-in of the treatment arm: the work log (the information the model
 * lacks), what repeated, and one guidance line. Sent as a user-role message at
 * the tail of the next request, so the cached prefix is untouched; the text asks
 * for a change of approach, not another try. Undefined when there is nothing to
 * say.
 */
export function buildCheckIn(
  steps: StuckStep[],
  report: StuckReport,
): string | undefined {
  const lead = leadSignal(report);
  if (!lead) return undefined;
  const guidance = CHECK_IN_GUIDANCE[lead.kind];
  const log = formatWorkLog(
    buildWorkLog(steps, { signals: false }),
    STUCK_EXPERIMENT.logLines,
  );
  return [
    `Check-in: the last turns look stuck (${lead.kind}: ${lead.key}, seen ${lead.count} times).`,
    "",
    "What has been tried:",
    log,
    "",
    guidance.line,
    "Change your approach; do not repeat what is listed above.",
  ].join("\n");
}

/** Decides, step by step, when a check-in is due: once per episode. */
export class CheckInGate {
  private armed = true;
  private quiet = 0;

  /** Feed the report after each step; true means send a check-in now. */
  due(report: StuckReport): boolean {
    if (report.level === "stuck") {
      this.quiet = 0;
      if (this.armed) {
        this.armed = false;
        return true;
      }
      return false;
    }
    if (report.signals.length === 0) {
      this.quiet++;
      if (this.quiet >= STUCK_EXPERIMENT.rearmAfterQuietSteps)
        this.armed = true;
    } else {
      this.quiet = 0;
    }
    return false;
  }
}

// ----------------------------------------------------------------------
// The scorer

/** One run of the stuck scenario, or of a healthy control. */
export interface ExperimentRun {
  model: string;
  arm: ExperimentArm;
  scenario: string;
  /** The scenario's check passed within the budget */
  recovered: boolean;
  /** Prompt plus completion tokens of the whole run */
  tokens: number;
  /** For a healthy control: the stuck signals reached `stuck` (a check-in would have fired) */
  fired?: boolean;
}

/** One-sided Fisher exact test: the chance of `a` or more successes in the first group by luck. */
export function fisherOneSided(
  a: number,
  n1: number,
  c: number,
  n2: number,
): number {
  const k = a + c;
  const total = n1 + n2;
  const logFact = (n: number) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const logChoose = (n: number, r: number) =>
    logFact(n) - logFact(r) - logFact(n - r);
  let p = 0;
  for (let x = a; x <= Math.min(n1, k); x++) {
    if (k - x > n2) continue;
    p += Math.exp(
      logChoose(n1, x) + logChoose(n2, k - x) - logChoose(total, k),
    );
  }
  return Math.min(1, p);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type ExperimentStatus =
  | "pass"
  | "fail"
  /** the control arm recovered too often or too rarely to show a lift */
  | "uninformative"
  /** fewer runs or models than the design needs */
  | "incomplete";

export interface ModelVerdict {
  model: string;
  control: { recovered: number; of: number };
  treatment: { recovered: number; of: number };
  lift: number;
  p: number;
  tokenRatio: number;
  checks: Record<"baseline" | "lift" | "significance" | "cost", boolean>;
}

export interface ExperimentVerdict {
  status: ExperimentStatus;
  models: ModelVerdict[];
  healthyFire: { fired: number; of: number; rate: number };
  /** What decided it, one line per failed or missing condition */
  reasons: string[];
}

/**
 * Applies the pass bar of STUCK_EXPERIMENT to the records. Pass needs, for
 * every model: the control's recovery in range, a lift of at least `minLift`,
 * Fisher p at most `fisherAlpha`, the token ratio within bounds; and the
 * healthy-control fire rate at most `maxHealthyFire`.
 */
export function scoreExperiment(runs: ExperimentRun[]): ExperimentVerdict {
  const cfg = STUCK_EXPERIMENT;
  const reasons: string[] = [];
  const stuckRuns = runs.filter((r) => r.scenario === STUCK_SCENARIO);
  const models = [...new Set(stuckRuns.map((r) => r.model))].sort();

  const verdicts: ModelVerdict[] = [];
  let incomplete = models.length < cfg.minModels;
  if (incomplete) {
    reasons.push(`needs ${cfg.minModels} models, has ${models.length}`);
  }
  for (const model of models) {
    const arm = (a: ExperimentArm) =>
      stuckRuns.filter((r) => r.model === model && r.arm === a);
    const control = arm("none");
    const treat = arm("checkin");
    if (control.length < cfg.runsPerArm || treat.length < cfg.runsPerArm) {
      incomplete = true;
      reasons.push(
        `${model}: needs ${cfg.runsPerArm} runs per arm, has ${control.length} and ${treat.length}`,
      );
    }
    const cr = control.filter((r) => r.recovered).length;
    const tr = treat.filter((r) => r.recovered).length;
    const cRate = control.length ? cr / control.length : 0;
    const tRate = treat.length ? tr / treat.length : 0;
    const p = fisherOneSided(tr, treat.length, cr, control.length);
    const tokenRatio =
      median(control.map((r) => r.tokens)) > 0
        ? median(treat.map((r) => r.tokens)) /
          median(control.map((r) => r.tokens))
        : Infinity;
    const checks = {
      baseline:
        cRate >= cfg.baselineRange.min && cRate <= cfg.baselineRange.max,
      lift: tRate - cRate >= cfg.minLift - 1e-9,
      significance: p <= cfg.fisherAlpha,
      cost: tokenRatio <= cfg.maxTokenRatio,
    };
    verdicts.push({
      model,
      control: { recovered: cr, of: control.length },
      treatment: { recovered: tr, of: treat.length },
      lift: tRate - cRate,
      p,
      tokenRatio,
      checks,
    });
  }

  const controls = runs.filter(
    (r) =>
      r.arm === "checkin" &&
      (HEALTHY_CONTROL_SCENARIOS as readonly string[]).includes(r.scenario),
  );
  for (const s of HEALTHY_CONTROL_SCENARIOS) {
    const n = controls.filter((r) => r.scenario === s).length;
    if (n < cfg.controlRunsPerScenario) {
      incomplete = true;
      reasons.push(`${s}: needs ${cfg.controlRunsPerScenario} runs, has ${n}`);
    }
  }
  const fired = controls.filter((r) => r.fired).length;
  const healthyFire = {
    fired,
    of: controls.length,
    rate: controls.length ? fired / controls.length : 0,
  };

  let status: ExperimentStatus;
  if (incomplete) {
    status = "incomplete";
  } else if (verdicts.some((v) => !v.checks.baseline)) {
    status = "uninformative";
    for (const v of verdicts) {
      if (!v.checks.baseline) {
        reasons.push(
          `${v.model}: control recovery ${v.control.recovered}/${v.control.of} is outside ${cfg.baselineRange.min} to ${cfg.baselineRange.max}`,
        );
      }
    }
  } else {
    const failed = verdicts.flatMap((v) =>
      (["lift", "significance", "cost"] as const)
        .filter((k) => !v.checks[k])
        .map((k) => `${v.model}: ${k}`),
    );
    if (healthyFire.rate > cfg.maxHealthyFire) {
      failed.push(
        `healthy control fire rate ${(healthyFire.rate * 100).toFixed(0)}% over ${cfg.maxHealthyFire * 100}%`,
      );
    }
    status = failed.length === 0 ? "pass" : "fail";
    reasons.push(...failed);
  }
  return { status, models: verdicts, healthyFire, reasons };
}
