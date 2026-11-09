import type {
  LoopCheckResult,
  LoopItemModel,
  LoopParallelRun,
  LoopState,
  TaskItem,
  TaskPlan,
} from "core";
import {
  blockingDependencies,
  describeLoopBudget,
  describeLoopReplan,
  loopReplanSetting,
  LoopReplanSetting,
  maxRoundsForReplan,
  unmetDependencies,
} from "core/util/loopMode";
import { useEffect, useState } from "react";
import { useAppDispatch } from "../../redux/hooks";
import {
  runLoopItemAgainThunk,
  setLoopBudgetThunk,
  skipLoopItemThunk,
} from "../../redux/thunks/loop";
import { stopLoopWorker } from "../../util/subagents/loopWorkers";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-1.5 text-xs text-foreground hover:bg-input";
const FIELD =
  "w-20 rounded border border-solid border-border bg-input px-1 text-xs text-foreground";

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
  return (
    <div
      data-testid={`loop-check-${task.id}`}
      className="text-2xs text-description-muted ml-3 min-w-0"
    >
      <div className="truncate" title={task.check ?? check?.command}>
        check: <code>{task.check ?? check?.command}</code>
        {check && (
          <span
            data-testid={`loop-check-result-${task.id}`}
            className={check.status === "failed" ? "text-error" : undefined}
          >
            {" "}
            · {CHECK_LABEL[check.status]}
            {check.status === "refused" && check.output
              ? `: ${check.output}`
              : ""}
          </span>
        )}
      </div>
      {check?.status === "failed" && check.output && (
        <pre
          data-testid={`loop-check-output-${task.id}`}
          className="m-0 max-h-16 overflow-auto whitespace-pre-wrap break-words"
        >
          {check.output.trim()}
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
      className="text-2xs text-description-muted ml-3 min-w-0 truncate"
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
      className="text-2xs text-description-muted ml-3 flex min-w-0 items-center gap-1"
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
      className="text-2xs text-description-muted ml-3 min-w-0 truncate"
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
    <details data-testid="loop-controls" className="text-description mt-1">
      <summary className="cursor-pointer">
        Items and limits · {describeLoopReplan(loop)}
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
                  <span className="text-foreground min-w-0 flex-1 truncate">
                    {task.id}. {task.text}
                  </span>
                  {dependency && (
                    <span
                      data-testid={`loop-after-${task.id}`}
                      className="text-description-muted shrink-0"
                    >
                      {dependency}
                    </span>
                  )}
                  <span className="text-description-muted shrink-0">
                    {statusLabel(loop, task.id)}
                  </span>
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
                <ModelLine task={task} model={state.model} />
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <label className="flex shrink-0 items-center gap-0.5">
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
            className="border-border bg-input text-foreground cursor-pointer rounded border border-solid px-1 text-xs"
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
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        {(
          [
            ["rounds", "Rounds"],
            ["tokens", "Tokens (0: none)"],
            ["minutes", "Minutes (0: none)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex shrink-0 items-center gap-0.5">
            {label}
            <input
              type="number"
              data-testid={`loop-limit-${key}`}
              min={0}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              className={FIELD}
            />
          </label>
        ))}
        <button
          type="button"
          data-testid="loop-limits-apply"
          className={BUTTON}
          title={describeLoopBudget(loop.budget)}
          onClick={async () =>
            report(
              await dispatch(
                setLoopBudgetThunk({
                  maxRounds: Number(draft.rounds),
                  maxTokens: Number(draft.tokens),
                  maxWallMs: Math.round(Number(draft.minutes) * 60000),
                }),
              ).unwrap(),
            )
          }
        >
          Apply
        </button>
      </div>
      {error && (
        <div
          role="alert"
          data-testid="loop-controls-error"
          className="text-error mt-0.5 break-words"
        >
          {error}
        </div>
      )}
    </details>
  );
}
