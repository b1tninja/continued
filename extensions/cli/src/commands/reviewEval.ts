/**
 * `continuous reviewer eval --dataset <file> --reviewer <model-role>
 * [--guidance <file>] [--compare <file>] [--run] [--json]`
 *
 * Scores a reviewer configuration (model plus prompt guidance) over a labelled
 * set of tool calls. The default is a dry run: it assembles the messages,
 * prints a cost plan and calls nothing. `--run` sends the requests.
 * See plans/reviewer-eval-gate.md.
 */

import { readFileSync } from "node:fs";

import {
  datasetFormat,
  parseDataset,
  parseGuidance,
  type ReviewDataset,
} from "core/tools/permissions/auto/evaluation/reviewEvalDataset.js";
import {
  formatCostPlan,
  formatGate,
  formatMetrics,
  formatPaired,
} from "core/tools/permissions/auto/evaluation/reviewEvalReport.js";
import {
  planCost,
  runReviewEval,
  type ReviewerClient,
  type ReviewerConfig,
} from "core/tools/permissions/auto/evaluation/reviewEvalRun.js";
import {
  comparePaired,
  gate,
  score,
  type GateResult,
  type Metrics,
  type Paired,
} from "core/tools/permissions/auto/evaluation/reviewEvalScore.js";

export interface ReviewEvalOptions {
  dataset?: string;
  /** A model name or the `reviewer` role (the default). */
  reviewer?: string;
  /** Guidance to try; absent is the built-in prompt alone. */
  guidance?: string;
  /** Baseline guidance file, or `default` for the built-in prompt alone. */
  compare?: string;
  /** Opaque id of a per-reviewer-model profile (a later slice). */
  profile?: string;
  /** Send the requests. Without it nothing is called. */
  run?: boolean;
  json?: boolean;
  concurrency?: number | string;
  timeoutMs?: number | string;
}

export interface ReviewEvalDeps {
  readFile: (path: string) => string;
  /** Build the reviewer client; only called with --run. */
  createClient: (
    reviewer: string | undefined,
  ) => Promise<{ client: ReviewerClient; model: string } | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** A reviewer client from the user's own assistant, as `Auto` builds it. */
async function defaultCreateClient(reviewer: string | undefined) {
  const { initializeServices, getService, SERVICE_NAMES } =
    await import("../services/index.js");
  const { createReviewer, reviewerModel } =
    await import("../permissions/coreRules.js");
  await initializeServices({ headless: true, skipOnboarding: true });
  const state = await getService<
    import("../services/types.js").ModelServiceState
  >(SERVICE_NAMES.MODEL);
  // authConfig is null for a person who has not signed in; the model client
  // does not use it, so a local config.yaml is enough.
  if (!state?.assistant) return null;
  const assistant =
    reviewer && reviewer !== "reviewer"
      ? ({
          ...state.assistant,
          modeModels: { reviewer: { model: reviewer } },
        } as typeof state.assistant)
      : state.assistant;
  const model = reviewerModel(assistant);
  const client = createReviewer(
    assistant,
    state.authConfig as Parameters<typeof createReviewer>[1],
  );
  if (!client || !model) return null;
  return { client, model: model.name ?? model.model };
}

const defaultDeps: ReviewEvalDeps = {
  readFile: (p) => readFileSync(p, "utf8"),
  createClient: defaultCreateClient,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

function guidanceConfig(
  path: string | undefined,
  deps: ReviewEvalDeps,
  fallbackLabel: string,
  profile?: string,
): ReviewerConfig {
  const base = profile ? { profile } : {};
  if (!path || path === "default") {
    return { label: fallbackLabel, ...base };
  }
  return {
    label: path,
    guidance: parseGuidance(deps.readFile(path), path),
    ...base,
  };
}

function toNumber(v: number | string | undefined, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

function summaryLine(dataset: ReviewDataset): string {
  const floor = dataset.cases.filter((c) => c.floor).length;
  return `Dataset ${dataset.name}: ${dataset.cases.length} cases, ${floor} floor, ${dataset.cases.length - floor} open middle.`;
}

interface Finished {
  metrics: Metrics;
  baseline?: { metrics: Metrics; paired: Paired };
  gate: GateResult;
}

function render(
  opts: ReviewEvalOptions,
  deps: ReviewEvalDeps,
  configs: ReviewerConfig[],
  model: string,
  f: Finished,
): void {
  if (opts.json) {
    deps.out(
      JSON.stringify(
        {
          dryRun: false,
          reviewer: model,
          candidate: { label: configs[0].label, profile: configs[0].profile },
          metrics: f.metrics,
          ...(f.baseline
            ? {
                baseline: {
                  label: configs[1].label,
                  metrics: f.baseline.metrics,
                },
                paired: f.baseline.paired,
              }
            : {}),
          gate: f.gate,
        },
        null,
        2,
      ),
    );
    return;
  }
  deps.out(`Reviewer: ${model}\n`);
  deps.out(formatMetrics(`Candidate: ${configs[0].label}`, f.metrics));
  if (f.baseline) {
    deps.out(
      `\n${formatMetrics(`Baseline: ${configs[1].label}`, f.baseline.metrics)}`,
    );
    deps.out(`\n### Paired comparison\n\n${formatPaired(f.baseline.paired)}`);
  }
  deps.out(`\n### Gate\n\n${formatGate(f.gate)}`);
}

/** Returns the exit code: 0, 1 when the gate fails or an error stops the run. */
export async function reviewEvalCommand(
  opts: ReviewEvalOptions,
  deps: ReviewEvalDeps = defaultDeps,
): Promise<number> {
  if (!opts.dataset) {
    deps.err("reviewer eval needs --dataset <file>.");
    return 1;
  }
  let dataset: ReviewDataset;
  let configs: ReviewerConfig[];
  try {
    dataset = parseDataset(
      deps.readFile(opts.dataset),
      datasetFormat(opts.dataset),
    );
    configs = [
      guidanceConfig(opts.guidance, deps, "built-in prompt", opts.profile),
    ];
    if (opts.compare) {
      configs.push(
        guidanceConfig(opts.compare, deps, "built-in prompt", opts.profile),
      );
    }
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const concurrency = toNumber(opts.concurrency, 4);

  if (!opts.run) {
    const plan = planCost(dataset, configs, concurrency);
    if (opts.json) {
      deps.out(
        JSON.stringify({ dryRun: true, plan, cases: dataset.cases.length }),
      );
    } else {
      deps.out(summaryLine(dataset));
      deps.out(formatCostPlan(plan, opts.reviewer ?? "reviewer"));
    }
    return 0;
  }

  const plan = planCost(dataset, configs, concurrency);
  if (!opts.json) deps.out(formatCostPlan(plan, opts.reviewer ?? "reviewer"));
  const made = await deps.createClient(opts.reviewer);
  if (!made) {
    deps.err(
      "No reviewer model is configured. Add one with the reviewer role.",
    );
    return 1;
  }
  const runOpts = {
    concurrency,
    timeoutMs: toNumber(opts.timeoutMs, 30_000),
  };
  // Sequential, so a baseline never competes with the candidate for rate limits.
  const candidateRun = await runReviewEval(
    made.client,
    dataset,
    configs[0],
    runOpts,
  );
  const metrics = score(dataset.cases, candidateRun.outcomes);
  let baseline: Finished["baseline"];
  if (configs[1]) {
    const baselineRun = await runReviewEval(
      made.client,
      dataset,
      configs[1],
      runOpts,
    );
    baseline = {
      metrics: score(dataset.cases, baselineRun.outcomes),
      paired: comparePaired(
        dataset.cases,
        baselineRun.outcomes,
        candidateRun.outcomes,
      ),
    };
  }
  const verdict = gate(dataset.cases, metrics, baseline);
  render(opts, deps, configs, made.model, { metrics, baseline, gate: verdict });
  return verdict.verdict === "not safe to adopt" ? 1 : 0;
}
