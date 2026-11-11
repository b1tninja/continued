import { formatCostAmount } from "../../../../util/costOf";
import type { CaseOutcome, CostPlan, RunResult } from "./reviewEvalRun";
import {
  GateResult,
  GroupRow,
  Metrics,
  Paired,
  Rate,
  significanceNote,
  Stability,
  value,
} from "./reviewEvalScore";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** "3.3% (3/90, 95% CI 1.1-9.3%)". */
export function showRate(r: Rate): string {
  if (r.n === 0 || r.low === null || r.high === null) return "n/a";
  return `${pct(value(r))} (${r.k}/${r.n}, 95% CI ${pct(r.low)}-${pct(r.high)})`;
}

const num = (x: number | undefined, digits = 0) =>
  x === undefined ? "n/a" : x.toFixed(digits);

function groupTable(title: string, rows: GroupRow[]): string[] {
  return [
    `#### ${title}`,
    "",
    "| Group | Cases | Agree | Safe ask | Allowed | Asked | Denied | False-allow | Over-block | Format fail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.n} | ${r.agree} | ${r.safeAsk} | ${r.allowed} | ${r.asked} | ${r.denied} | ${r.falseAllow} | ${r.overBlock} | ${r.formatFailures} |`,
    ),
    "",
  ];
}

/** Test-retest flips and per-case agreement across the repeated runs. */
export function formatStability(st: Stability): string {
  const unstable = st.cases.filter((c) => c.flips > 0);
  return [
    `#### Stability over ${st.runs} runs`,
    "",
    `Test-retest flip rate (cases whose decision changed between runs): ${showRate(st.flipRate)}`,
    `Floor cases allowed in any run: ${st.floorUnionIds.length ? st.floorUnionIds.join(", ") : "none"}`,
    "",
    ...(unstable.length
      ? [
          "| Case | Label | Decisions | Flips | Runs agreeing |",
          "| --- | --- | --- | --- | --- |",
          ...unstable.map(
            (c) =>
              `| ${c.id} | ${c.expected} | ${c.decisions.join(", ")} | ${c.flips} | ${c.agreeRuns}/${st.runs} |`,
          ),
        ]
      : ["Every case got the same decision in every run."]),
  ].join("\n");
}

export function formatMetrics(label: string, m: Metrics): string {
  return [
    `### ${label}`,
    "",
    "| Measure | Result |",
    "| --- | --- |",
    `| Cases | ${m.n} |`,
    `| Agreement, lenient (an accepted verdict, or ask for a deny) | ${showRate(m.agreement)} |`,
    `| Agreement, strict (exactly the label) | ${showRate(m.strictAgreement)} |`,
    `| Safe ask for deny (asked where deny was labelled; not a miss) | ${showRate(m.safeAskForDeny)} |`,
    `| False-allow rate (safety; allowed though the case does not accept allow) | ${showRate(m.falseAllow)} |`,
    `| False-allow on floor cases (must be 0${m.stability ? `; union of ${m.stability.runs} runs` : ""}) | ${showRate(m.floorFalseAllow)} |`,
    `| Over-block rate (not allowed though labelled allow) | ${showRate(m.overBlock)} |`,
    `| Ask rate | ${showRate(m.askRate)} |`,
    `| Format-failure rate (unreadable replies, failed closed to ask) | ${showRate(m.formatFailure)} |`,
    `| Truncated by the output ceiling (no verdict; subset of format failures) | ${showRate(m.truncated)} |`,
    `| Call errors or timeouts (failed closed to ask) | ${m.errors} |`,
    `| Mean latency | ${num(m.meanLatencyMs)} ms |`,
    `| Mean input / output tokens | ${num(m.meanInputTokens)} / ${num(m.meanOutputTokens)} |`,
    `| Cache read / write share of input | ${m.cacheReadShare === undefined ? "not reported" : `${pct(m.cacheReadShare)} / ${pct(m.cacheWriteShare ?? 0)}`} |`,
    "",
    ...(m.stability ? [formatStability(m.stability), ""] : []),
    ...groupTable("By category", m.byCategory),
    ...groupTable("By policy area", m.byArea),
  ].join("\n");
}

export function formatGate(g: GateResult): string {
  const mark = (p: boolean | "n/a") =>
    p === "n/a" ? "n/a" : p ? "pass" : "FAIL";
  return [
    `Gate verdict: ${g.verdict}`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...g.checks.map((c) => `| ${c.name} | ${mark(c.pass)} | ${c.detail} |`),
  ].join("\n");
}

export function formatPaired(p: Paired): string {
  return [
    "| Paired counts | Both bad | Only baseline | Only candidate | Sign test p |",
    "| --- | --- | --- | --- | --- |",
    `| False-allow (cases labelled ask or deny, n=${p.falseAllow.n}) | ${p.falseAllow.both} | ${p.falseAllow.onlyBaseline} | ${p.falseAllow.onlyCandidate} | ${p.falseAllow.p.toFixed(3)} |`,
    `| Over-block (cases labelled allow, n=${p.overBlock.n}) | ${p.overBlock.both} | ${p.overBlock.onlyBaseline} | ${p.overBlock.onlyCandidate} | ${p.overBlock.p.toFixed(3)} |`,
    "",
    `Agreement with the label: both ${p.agreement.both}, only baseline ${p.agreement.onlyBaseline}, only candidate ${p.agreement.onlyCandidate}, neither ${p.agreement.neither}.`,
    "",
    significanceNote(p),
    ...(p.flips.length
      ? [
          "",
          "| Case | Label | Baseline | Candidate |",
          "| --- | --- | --- | --- |",
          ...p.flips.map(
            (f) =>
              `| ${f.id} | ${f.expected} | ${f.baseline} | ${f.candidate} |`,
          ),
        ]
      : []),
  ].join("\n");
}

function estimate(c: NonNullable<CostPlan["cost"]>): string {
  return c.amount === "unknown"
    ? "unknown (no price for this model)"
    : `about ${formatCostAmount(c.amount)} at most (list price; every reply at the ceiling)`;
}

export function formatCostPlan(plan: CostPlan, reviewer: string): string {
  return [
    "Dry run: no model was called.",
    "",
    `Reviewer: ${reviewer}`,
    `Calls: ${plan.calls} (${plan.configs} configuration${plan.configs === 1 ? "" : "s"})`,
    `Estimated input: about ${plan.estInputTokens.toLocaleString("en-US")} tokens (4 characters a token)`,
    `Output: at most ${plan.maxOutputTokens.toLocaleString("en-US")} tokens (ceiling ${plan.maxTokens} a reply)`,
    ...(plan.repeat > 1 ? [`Each case asked ${plan.repeat} times`] : []),
    `Estimated cost: ${plan.cost ? estimate(plan.cost) : "unknown (model not known)"}`,
    ...plan.warnings.map((w) => `WARNING: ${w}`),
    `Concurrency: ${plan.concurrency}`,
    "",
    "Add --run to send these requests. They are billed by the provider.",
  ].join("\n");
}

/** Everything that identifies a run, for the --json output. */
export function runSummary(r: RunResult) {
  return { label: r.config.label, profile: r.config.profile ?? null };
}

/**
 * One JSON object per line for every outcome of every run. The dataset's case
 * text is not repeated: the id joins it back to the dataset.
 */
export function outcomeLines(
  cases: { id: string; expected: string; accept?: string[] }[],
  runs: CaseOutcome[][],
  config: string,
): string[] {
  const label = new Map(cases.map((c) => [c.id, c]));
  return runs.flatMap((outcomes, run) =>
    outcomes.map((o) =>
      JSON.stringify({
        config,
        run: run + 1,
        id: o.id,
        label: label.get(o.id)?.expected,
        accept: label.get(o.id)?.accept,
        verdict: o.decision,
        category: o.category,
        parsed: !o.formatFailure,
        formatFailure: o.formatFailure,
        truncated: o.truncated,
        error: o.error,
        finishReason: o.finishReason,
        inputTokens: o.inputTokens,
        outputTokens: o.outputTokens,
        cacheReadTokens: o.cacheReadTokens,
        cacheWriteTokens: o.cacheWriteTokens,
        latencyMs: o.ms,
        rawReply: o.rawReply,
      }),
    ),
  );
}
