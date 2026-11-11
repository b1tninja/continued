import type { CostPlan, RunResult } from "./reviewEvalRun";
import {
  GateResult,
  GroupRow,
  Metrics,
  Paired,
  Rate,
  significanceNote,
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
    "| Group | Cases | Agree | Allowed | Asked | Denied | False-allow | Over-block | Format fail |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.n} | ${r.agree} | ${r.allowed} | ${r.asked} | ${r.denied} | ${r.falseAllow} | ${r.overBlock} | ${r.formatFailures} |`,
    ),
    "",
  ];
}

export function formatMetrics(label: string, m: Metrics): string {
  return [
    `### ${label}`,
    "",
    "| Measure | Result |",
    "| --- | --- |",
    `| Cases | ${m.n} |`,
    `| Agreement with labels | ${showRate(m.agreement)} |`,
    `| False-allow rate (safety; allowed though labelled ask or deny) | ${showRate(m.falseAllow)} |`,
    `| False-allow on floor cases (must be 0) | ${showRate(m.floorFalseAllow)} |`,
    `| Over-block rate (not allowed though labelled allow) | ${showRate(m.overBlock)} |`,
    `| Ask rate | ${showRate(m.askRate)} |`,
    `| Format-failure rate (unreadable replies, failed closed to ask) | ${showRate(m.formatFailure)} |`,
    `| Call errors or timeouts (failed closed to ask) | ${m.errors} |`,
    `| Mean latency | ${num(m.meanLatencyMs)} ms |`,
    `| Mean input / output tokens | ${num(m.meanInputTokens)} / ${num(m.meanOutputTokens)} |`,
    `| Cache read share of input | ${m.cacheReadShare === undefined ? "not reported" : pct(m.cacheReadShare)} |`,
    "",
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

export function formatCostPlan(plan: CostPlan, reviewer: string): string {
  return [
    "Dry run: no model was called.",
    "",
    `Reviewer: ${reviewer}`,
    `Calls: ${plan.calls} (${plan.configs} configuration${plan.configs === 1 ? "" : "s"})`,
    `Estimated input: about ${plan.estInputTokens.toLocaleString("en-US")} tokens (4 characters a token)`,
    `Output: at most ${plan.maxOutputTokens.toLocaleString("en-US")} tokens`,
    `Concurrency: ${plan.concurrency}`,
    "",
    "Add --run to send these requests. They are billed by the provider.",
  ].join("\n");
}

/** Everything that identifies a run, for the --json output. */
export function runSummary(r: RunResult) {
  return { label: r.config.label, profile: r.config.profile ?? null };
}
