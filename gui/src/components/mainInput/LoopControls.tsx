import type { LoopState, TaskPlan } from "core";
import {
  describeLoopBudget,
  describeLoopReplan,
  loopReplanSetting,
  LoopReplanSetting,
  maxRoundsForReplan,
} from "core/util/loopMode";
import { useEffect, useState } from "react";
import { useAppDispatch } from "../../redux/hooks";
import {
  runLoopItemAgainThunk,
  setLoopBudgetThunk,
  skipLoopItemThunk,
} from "../../redux/thunks/loop";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-1.5 text-xs text-foreground hover:bg-input";
const FIELD =
  "w-20 rounded border border-solid border-border bg-input px-1 text-xs text-foreground";

function statusLabel(loop: LoopState, itemId: string): string {
  const state = loop.items.find((i) => i.id === itemId);
  if (!state) return "";
  if (state.skipped) return "skipped";
  if (state.again && state.status === "pending") return "to run again";
  return state.status;
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
    <details data-testid="loop-controls" className="mt-1 text-description">
      <summary className="cursor-pointer">
        Items and limits · {describeLoopReplan(loop)}
      </summary>
      {taskPlan && (
        <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto p-0">
          {taskPlan.items.map((task) => {
            const state = loop.items.find((i) => i.id === task.id);
            if (!state) return null;
            const canSkip =
              state.status !== "running" && state.status !== "done";
            const canAgain =
              state.status === "done" || state.status === "failed";
            return (
              <li
                key={task.id}
                data-testid={`loop-item-${task.id}`}
                className="flex min-w-0 items-center gap-1"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {task.id}. {task.text}
                </span>
                <span className="shrink-0 text-description-muted">
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
                        await dispatch(runLoopItemAgainThunk(task.id)).unwrap(),
                      )
                    }
                  >
                    Run again
                  </button>
                )}
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
            className="cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
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
          className="mt-0.5 break-words text-error"
        >
          {error}
        </div>
      )}
    </details>
  );
}
