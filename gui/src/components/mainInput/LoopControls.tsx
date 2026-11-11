import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import type {
  LoopCheckResult,
  LoopItemModel,
  LoopParallelRun,
  LoopState,
  TaskItem,
  TaskPlan,
} from "core";
import { describeBreach } from "core/util/itemBudget";
import {
  LIMIT_POLICIES,
  LIMIT_POLICY_LABEL,
  limitPolicyOf,
  type LimitPolicy,
} from "core/util/itemBudgetPolicy";
import {
  blockingDependencies,
  describeLoopBudget,
  describeLoopReplan,
  LOOP_AUTONOMY,
  loopReplanSetting,
  LoopReplanSetting,
  loopTokensFromUsage,
  maxRoundsForReplan,
  unmetDependencies,
} from "core/util/loopMode";
import { formatCostAmount } from "core/util/costOf";
import { costMarkOf, dollarBudgetNote, itemCostNow } from "core/util/loopCost";
import {
  describeRoundUsage,
  describeTimeUsage,
  describeTokenUsage,
  formatDuration,
  formatTokenCount,
  loopUsage,
} from "core/util/loopUsage";
import { useEffect, useId, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  runLoopItemAgainThunk,
  setLoopBudgetThunk,
  skipLoopItemThunk,
} from "../../redux/thunks/loop";
import { setLimitPolicyThunk } from "../../redux/thunks/loopBudget";
import { stopLoopWorker } from "../../util/subagents/loopWorkers";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input";
const FIELD =
  "w-20 rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground";

function statusLabel(loop: LoopState, itemId: string): string {
  const state = loop.items.find((i) => i.id === itemId);
  if (!state) return "";
  if (state.skipped) return "skipped";
  if (state.again && state.status === "pending") return "to run again";
  switch (state.status) {
    case "checking":
      return loop.current?.kind === "check" && loop.current.itemId === itemId
        ? "checking"
        : "check waits";
    case "running":
      return loop.parallel?.some((r) => r.itemId === itemId)
        ? "running in parallel"
        : "running";
    case "pending":
    case "redo":
    case "done":
    case "waiting":
    case "failed":
      return state.status;
  }
}

/** What the item comes after, while it waits for it: "after 1" or "blocked on 1". */
function dependencyLabel(
  loop: LoopState,
  taskPlan: TaskPlan,
  task: TaskItem,
): string | undefined {
  const state = loop.items.find((i) => i.id === task.id);
  if (state?.status !== "pending" && state?.status !== "redo") return;
  if (state.skipped) return;
  const blocked = blockingDependencies(loop, taskPlan, task);
  if (blocked.length) return `blocked on ${blocked.join(", ")}`;
  const unmet = unmetDependencies(loop, taskPlan, task);
  return unmet.length ? `after ${unmet.join(", ")}` : undefined;
}

const CHECK_LABEL: Record<LoopCheckResult["status"], string> = {
  passed: "check passed",
  failed: "check failed",
  refused: "check not run",
};

/** The item's check and its last result, with a failure's output. */
function CheckLine({
  task,
  check,
}: {
  task: TaskItem;
  check?: LoopCheckResult;
}) {
  if (!task.check && !check) return null;
  const shownCheck = maskCommandForDisplay(task.check ?? check?.command ?? "");
  return (
    <div
      data-testid={`loop-check-${task.id}`}
      className="ml-3 min-w-0 text-2xs text-description"
    >
      <div className="truncate" title={shownCheck}>
        check: <code>{shownCheck}</code>
        {check && (
          <span
            data-testid={`loop-check-result-${task.id}`}
            className={check.status === "failed" ? "text-error" : undefined}
          >
            {" "}
            · {CHECK_LABEL[check.status]}
            {check.status === "refused" && check.output
              ? `: ${maskCommandForDisplay(check.output)}`
              : ""}
          </span>
        )}
      </div>
      {check?.status === "failed" && check.output && (
        <pre
          data-testid={`loop-check-output-${task.id}`}
          className="m-0 max-h-16 overflow-auto break-words whitespace-pre-wrap"
        >
          {maskCommandForDisplay(check.output.trim())}
        </pre>
      )}
    </div>
  );
}

/** The files the to-do declares (TaskItem.files): what a parallel run may change. */
function FilesLine({ task }: { task: TaskItem }) {
  if (!task.files?.length) return null;
  return (
    <div
      data-testid={`loop-files-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title="The files this item changes; items with disjoint files may run at the same time"
    >
      files: <code>{task.files.join(", ")}</code>
    </div>
  );
}

/**
 * An item running as a worker of a parallel wave: its worktree, the model it
 * runs on, and a Stop for this worker alone (its item runs again later).
 */
function WorkerLine({
  task,
  run,
  model,
}: {
  task: TaskItem;
  run: LoopParallelRun;
  model?: LoopItemModel;
}) {
  return (
    <div
      data-testid={`loop-worker-${task.id}`}
      className="ml-3 flex min-w-0 items-center gap-1 text-2xs text-description"
    >
      <span className="min-w-0 flex-1 truncate" title={run.worktree}>
        in its own worktree{run.worktree ? `: ${run.worktree}` : ""}
        {model?.title ? ` · ${model.title}` : ""}
      </span>
      <button
        type="button"
        data-testid={`loop-worker-stop-${task.id}`}
        className={BUTTON}
        title="Stop this worker; its changes are dropped and the item runs again later"
        onClick={() => stopLoopWorker(task.id)}
      >
        Stop
      </button>
    </div>
  );
}

/**
 * The model the to-do names (TaskItem.model) and, once a run started, the one
 * it went to when that was not it: the item's own model is not configured.
 */
function ModelLine({ task, model }: { task: TaskItem; model?: LoopItemModel }) {
  if (!task.model) return null;
  return (
    <div
      data-testid={`loop-model-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title={model?.fallbackReason ?? "The model this item runs with"}
    >
      model: {task.model}
      {model?.fallbackReason && (
        <span
          data-testid={`loop-model-fallback-${task.id}`}
          className="text-warning"
        >
          {" "}
          · not configured, ran on {model.title}
        </span>
      )}
    </div>
  );
}

/**
 * The item's own budget (TaskItem.budget) with what its runs used and what is
 * left of it; shown when the item has one. An item that ran over says so.
 */
function BudgetLine({
  task,
  state,
  loop,
}: {
  task: TaskItem;
  state: LoopState["items"][number];
  loop: LoopState;
}) {
  const sessionUsage = useAppSelector((s) => s.session.usage);
  const budget = task.budget;
  if (!budget && !state.overBudget) return null;
  const parts: string[] = [];
  const tokens = state.usage?.tokens ?? 0;
  const minutes = (state.usage?.ms ?? 0) / 60_000;
  if (budget?.tokens !== undefined) {
    parts.push(
      `${formatTokenCount(tokens)} of ${formatTokenCount(budget.tokens)} tokens, ${formatTokenCount(Math.max(0, budget.tokens - tokens))} left`,
    );
  }
  if (budget?.minutes !== undefined) {
    parts.push(
      `${formatDuration(minutes * 60_000)} of ${budget.minutes}m, ${formatDuration(Math.max(0, budget.minutes - minutes) * 60_000)} left`,
    );
  }
  if (budget?.turns !== undefined) parts.push(`${budget.turns} turns a run`);
  const cost = itemCostNow(loop, task.id, costMarkOf(sessionUsage));
  if (budget?.usd !== undefined && typeof cost === "number") {
    parts.push(
      `${formatCostAmount(cost)} of ${formatCostAmount(budget.usd)}, ${formatCostAmount(Math.max(0, budget.usd - cost))} left`,
    );
  }
  const costNote = dollarBudgetNote(budget, cost);
  if (costNote) parts.push(costNote);
  return (
    <div
      data-testid={`loop-budget-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title="The item's own budget and what is left of it"
    >
      budget: {parts.join(" · ")}
      {state.extensions ? ` · extended ${state.extensions}×` : ""}
      {state.overBudget && (
        <span
          data-testid={`loop-over-budget-${task.id}`}
          className="text-error"
        >
          {" "}
          · {describeBreach(state.overBudget)}
        </span>
      )}
    </div>
  );
}

/** One limit as a label, a bar and what is left; the bar warns from 80%. */
function UsageMeter({
  label,
  testId,
  fraction,
  text,
}: {
  label: string;
  testId: string;
  fraction: number | undefined;
  text: string;
}) {
  const tone =
    fraction === undefined
      ? "bg-description-muted"
      : fraction >= 1
        ? "bg-error"
        : fraction >= 0.8
          ? "bg-warning"
          : "bg-link";
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-center gap-1 text-description"
    >
      <span className="w-12 shrink-0">{label}</span>
      <span className="h-1 w-16 shrink-0 overflow-hidden rounded bg-input">
        <span
          className={`block h-full ${tone}`}
          style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }}
        />
      </span>
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

/**
 * What the loop has used and what is left of each limit, with the totals: runs
 * and items done. Shown once a budget has been set. The clock ticks while the
 * loop runs.
 */
function LoopUsagePanel({ loop }: { loop: LoopState }) {
  const sessionUsage = useAppSelector((s) => s.session.usage);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (loop.status === "stopped") return;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [loop.status]);
  const u = loopUsage(loop, {
    sessionTokens: sessionUsage ? loopTokensFromUsage(sessionUsage) : 0,
    costMark: costMarkOf(sessionUsage),
    now,
  });
  return (
    <div data-testid="loop-usage" className="mt-1 flex flex-col gap-0.5">
      <UsageMeter
        label="Rounds"
        testId="loop-usage-rounds"
        fraction={u.rounds.max > 0 ? u.rounds.used / u.rounds.max : undefined}
        text={describeRoundUsage(u.rounds)}
      />
      <UsageMeter
        label="Tokens"
        testId="loop-usage-tokens"
        fraction={u.tokens.fraction}
        text={describeTokenUsage(u.tokens)}
      />
      <UsageMeter
        label="Time"
        testId="loop-usage-time"
        fraction={u.time.fraction}
        text={describeTimeUsage(u.time)}
      />
      <div
        data-testid="loop-usage-cost"
        className="text-description"
        title="An estimate at list price, from the session's usage by model"
      >
        Cost: {formatCostAmount(u.cost)}
      </div>
      <div data-testid="loop-usage-totals" className="text-description">
        {u.items.done}/{u.items.total} done · {u.runs} run
        {u.runs === 1 ? "" : "s"}
      </div>
    </div>
  );
}

/** The limits as the editor's fields: rounds, tokens, minutes (0: no limit). */
function draftOf(loop: LoopState) {
  return {
    rounds: String(loop.budget.maxRounds),
    tokens: String(loop.budget.maxTokens),
    minutes: String(Math.round(loop.budget.maxWallMs / 60000)),
  };
}

/**
 * The loop's controls, under its status in the inbox: skip an item or run it
 * again, how often to re-plan, and the limits. Every decision and bound is
 * core's (skipItem, runItemAgain, setLoopBudget); a refusal shows here.
 */
export function LoopControls({
  loop,
  taskPlan,
}: {
  loop: LoopState;
  taskPlan?: TaskPlan;
}) {
  const dispatch = useAppDispatch();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState(() => draftOf(loop));
  // The limits are out of sight until asked for
  const [budgetOpen, setBudgetOpen] = useState(false);
  // Below the xs breakpoint the re-plan, budget and usage controls fold behind one "Limits" button
  const [limitsOpen, setLimitsOpen] = useState(false);
  const limitsId = useId();
  // Once a budget has been set, or differs from the level's own, show what is left
  const [budgetApplied, setBudgetApplied] = useState(false);
  const preset = LOOP_AUTONOMY[loop.autonomy ?? "auto"].budget;
  const showUsage =
    budgetApplied ||
    loop.budget.maxRounds !== preset.maxRounds ||
    loop.budget.maxTokens !== preset.maxTokens ||
    loop.budget.maxWallMs !== preset.maxWallMs;
  const { maxRounds, maxTokens, maxWallMs } = loop.budget;
  useEffect(() => setDraft(draftOf(loop)), [maxRounds, maxTokens, maxWallMs]);

  const report = (result: { ok: boolean; error?: string }) =>
    setError(result.ok ? undefined : result.error);
  const setReplan = async (setting: LoopReplanSetting) =>
    report(
      await dispatch(
        setLoopBudgetThunk({ maxRounds: maxRoundsForReplan(loop, setting) }),
      ).unwrap(),
    );
  const replan = loopReplanSetting(loop);

  return (
    <details data-testid="loop-controls" open className="mt-1 text-description">
      <summary className="cursor-pointer">
        Plan and limits · {describeLoopReplan(loop)}
      </summary>
      {taskPlan && (
        <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto p-0">
          {taskPlan.items.map((task) => {
            const state = loop.items.find((i) => i.id === task.id);
            if (!state) return null;
            const checkRunning =
              loop.current?.kind === "check" && loop.current.itemId === task.id;
            const canSkip =
              state.status !== "running" &&
              state.status !== "done" &&
              !checkRunning;
            const canAgain =
              state.status === "done" || state.status === "failed";
            const dependency = dependencyLabel(loop, taskPlan, task);
            const worker = loop.parallel?.find((r) => r.itemId === task.id);
            return (
              <li key={task.id} className="min-w-0">
                <div
                  data-testid={`loop-item-${task.id}`}
                  className="flex min-w-0 items-center gap-1"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-foreground"
                    title={`${task.id}. ${task.text}`}
                  >
                    {task.id}. {task.text}
                  </span>
                  {dependency && (
                    <span
                      data-testid={`loop-after-${task.id}`}
                      className="shrink-0 text-description"
                    >
                      {dependency}
                    </span>
                  )}
                  <span className="shrink-0 text-description">
                    {statusLabel(loop, task.id)}
                  </span>
                  {showUsage && state.attempts > 0 && (
                    <span
                      data-testid={`loop-runs-${task.id}`}
                      className="shrink-0 text-description"
                    >
                      {state.attempts} run{state.attempts === 1 ? "" : "s"}
                      {state.usage
                        ? ` · ${formatTokenCount(state.usage.tokens)} tokens${
                            state.usage.cost !== undefined
                              ? ` · ${formatCostAmount(state.usage.cost)}`
                              : ""
                          } · ${formatDuration(state.usage.ms)}`
                        : ""}
                    </span>
                  )}
                  {canSkip && (
                    <button
                      type="button"
                      data-testid={`loop-skip-${task.id}`}
                      className={BUTTON}
                      onClick={async () =>
                        report(
                          await dispatch(skipLoopItemThunk(task.id)).unwrap(),
                        )
                      }
                    >
                      Skip
                    </button>
                  )}
                  {canAgain && (
                    <button
                      type="button"
                      data-testid={`loop-again-${task.id}`}
                      className={BUTTON}
                      onClick={async () =>
                        report(
                          await dispatch(
                            runLoopItemAgainThunk(task.id),
                          ).unwrap(),
                        )
                      }
                    >
                      Run again
                    </button>
                  )}
                </div>
                {worker && (
                  <WorkerLine task={task} run={worker} model={state.model} />
                )}
                <CheckLine task={task} check={state.check} />
                <FilesLine task={task} />
                <BudgetLine task={task} state={state} loop={loop} />
                <ModelLine task={task} model={state.model} />
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        data-testid="loop-limits-toggle"
        aria-expanded={limitsOpen}
        aria-controls={limitsId}
        className="mt-1 min-h-6 cursor-pointer border-none bg-transparent px-0 text-xs text-link hover:underline xs:hidden"
        onClick={() => setLimitsOpen(!limitsOpen)}
      >
        {limitsOpen ? "Hide limits" : "Limits�"}
      </button>
      <div id={limitsId} className={limitsOpen ? "block" : "hidden xs:block"}>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <label className="flex shrink-0 items-center gap-0.5 py-1">
            Re-plan
            <select
              data-testid="loop-replan"
              value={replan.kind}
              onChange={(e) => {
                const kind = e.target.value as LoopReplanSetting["kind"];
                void setReplan(
                  kind === "up_to"
                    ? { kind, replans: Math.max(1, maxRounds - 1) }
                    : { kind },
                );
              }}
              className="cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
            >
              <option value="never">never</option>
              <option value="up_to">up to N times</option>
              <option value="until_done">until done</option>
            </select>
          </label>
          {replan.kind === "up_to" && (
            <input
              type="number"
              data-testid="loop-replan-count"
              min={1}
              value={replan.replans}
              onChange={(e) => {
                const replans = Number(e.target.value);
                // An emptied field is not "never"; wait for a number
                if (replans >= 1) void setReplan({ kind: "up_to", replans });
              }}
              className={FIELD}
            />
          )}
          <button
            type="button"
            data-testid="loop-budget-toggle"
            aria-expanded={budgetOpen}
            title={describeLoopBudget(loop.budget)}
            className="min-h-6 shrink-0 cursor-pointer border-none bg-transparent px-1 text-xs text-link hover:underline"
            onClick={() => {
              if (budgetOpen) setDraft(draftOf(loop));
              setBudgetOpen(!budgetOpen);
            }}
          >
            {budgetOpen ? "Hide the budget" : "Set a budget…"}
          </button>
        </div>
        {showUsage && <LoopUsagePanel loop={loop} />}
        {budgetOpen && (
          <div
            data-testid="loop-budget"
            className="mt-1 flex min-w-0 flex-wrap items-center gap-1"
          >
            {(
              [
                ["rounds", "Rounds"],
                ["tokens", "Tokens (0: none)"],
                ["minutes", "Minutes (0: none)"],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex shrink-0 items-center gap-0.5 py-1"
              >
                {label}
                <input
                  type="number"
                  data-testid={`loop-limit-${key}`}
                  min={0}
                  value={draft[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                  className={FIELD}
                />
              </label>
            ))}
            <label
              className="flex shrink-0 items-center gap-0.5 py-1"
              title="When a to-do uses up its own budget: Suggest asks you, Force stops it, Review has its work reviewed and extends it once if it is progressing"
            >
              At a to-do's limit
              <select
                data-testid="loop-limit-policy"
                value={limitPolicyOf(loop)}
                onChange={(e) =>
                  void dispatch(
                    setLimitPolicyThunk(e.target.value as LimitPolicy),
                  )
                }
                className="cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
              >
                {LIMIT_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {LIMIT_POLICY_LABEL[policy]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="loop-limits-apply"
              className={BUTTON}
              title={describeLoopBudget(loop.budget)}
              onClick={async () => {
                const result = await dispatch(
                  setLoopBudgetThunk({
                    maxRounds: Number(draft.rounds),
                    maxTokens: Number(draft.tokens),
                    maxWallMs: Math.round(Number(draft.minutes) * 60000),
                  }),
                ).unwrap();
                report(result);
                // Applied: the fields go away; a refusal keeps them open
                if (result.ok) {
                  setBudgetOpen(false);
                  setBudgetApplied(true);
                }
              }}
            >
              Apply
            </button>
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          data-testid="loop-controls-error"
          className="mt-0.5 break-words text-error"
        >
          {error}
        </div>
      )}
    </details>
  );
}
