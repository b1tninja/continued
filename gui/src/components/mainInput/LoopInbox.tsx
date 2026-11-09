import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { LoopAutonomy, LoopQuestion, LoopStrategy } from "core";
import {
  formatLoopStatus,
  LOOP_AUTONOMY,
  LOOP_LIMITS,
  LOOP_STRATEGIES,
  LOOP_STRATEGY_ORDER,
  loopStrategy,
  standingInstructions,
} from "core/util/loopMode";
import { policyLevelLabel } from "core/tools/permissions/policy";
import { useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { LoopControls } from "./LoopControls";
import {
  answerLoopQuestion,
  endLoopThunk,
  LoopAnswerInput,
  resumeLoopThunk,
  setLoopStrategyThunk,
  stopLoopThunk,
} from "../../redux/thunks/loop";

/**
 * Loop mode's inbox, above the input: where the loop is, the questions its
 * items hold, and a note about the whole plan. Answers can be given at any
 * time; the loop routes each one (core/util/loopMode.ts answerLoop).
 */
export function LoopInbox() {
  const dispatch = useAppDispatch();
  const loop = useAppSelector((s) => s.session.loop);
  const taskPlan = useAppSelector((s) => s.session.taskPlan);
  const [note, setNote] = useState("");
  const [replanNow, setReplanNow] = useState(false);
  const [standing, setStanding] = useState(false);
  const [noteError, setNoteError] = useState<string>();
  if (!loop) return null;

  const open = loop.questions.filter((q) => !q.answerId);
  const standingNotes = standingInstructions(loop);
  const onAnswer = async (input: LoopAnswerInput) => {
    const result = await dispatch(answerLoopQuestion(input)).unwrap();
    return result.ok ? undefined : result.error;
  };
  const stopped = loop.status === "stopped";

  return (
    <div
      data-testid="loop-inbox"
      className="mx-1 mb-1 min-w-0 rounded border border-solid border-border px-2 py-1 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <ArrowPathIcon className="h-3 w-3 shrink-0 text-description" />
        <span
          data-testid="loop-status"
          className="min-w-0 flex-1 basis-40 break-words text-description"
        >
          Loop · {formatLoopStatus(loop, { level: false })}
        </span>
        <span
          data-testid="loop-policy"
          title="Plan edits and Questions: change them in the toolbar or in Settings > Tools"
          className="shrink-0 text-description"
        >
          Plan {policyLevelLabel("plan", loop.policy?.plan ?? "cautious")} ·
          Questions{" "}
          {policyLevelLabel("questions", loop.policy?.questions ?? "cautious")}
        </span>
        <select
          data-testid="loop-strategy"
          value={loopStrategy(loop)}
          title={LOOP_STRATEGIES[loopStrategy(loop)].description}
          onChange={(e) =>
            void dispatch(setLoopStrategyThunk(e.target.value as LoopStrategy))
          }
          className="shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
        >
          {LOOP_STRATEGY_ORDER.map((strategy) => (
            <option key={strategy} value={strategy}>
              {LOOP_STRATEGIES[strategy].label}
            </option>
          ))}
        </select>
        {stopped ? (
          <>
            {loop.stopReason !== "done" && (
              <button
                type="button"
                data-testid="loop-resume"
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-link hover:underline"
                onClick={() => void dispatch(resumeLoopThunk())}
              >
                Resume
              </button>
            )}
            <button
              type="button"
              data-testid="loop-end"
              className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-description-muted hover:text-foreground"
              onClick={() => void dispatch(endLoopThunk())}
            >
              Close
            </button>
          </>
        ) : (
          <>
            {!loop.stopRequested && (
              <button
                type="button"
                data-testid="loop-stop"
                title="Stop once the running item or re-plan ends"
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-link hover:underline"
                onClick={() => void dispatch(stopLoopThunk())}
              >
                Stop after this item
              </button>
            )}
            {loop.current && (
              <button
                type="button"
                data-testid="loop-stop-now"
                title="Stop the running item now; it goes back to pending"
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-link hover:underline"
                onClick={() => void dispatch(cancelStream())}
              >
                Stop now
              </button>
            )}
          </>
        )}
      </div>
      {loop.current?.kind === "check" && (
        <div
          data-testid="loop-check-running"
          className="mt-0.5 truncate text-description"
        >
          Running the check for {loop.current.itemId}:{" "}
          <code>
            {taskPlan?.items.find((i) => i.id === loop.current?.itemId)?.check}
          </code>
        </div>
      )}
      <LoopControls loop={loop} taskPlan={taskPlan} />
      {loop.status === "awaiting_plan" && loop.replanReason && (
        <div
          data-testid="loop-replan-reason"
          className="mt-0.5 text-description"
        >
          New plan waiting on its card: {loop.replanReason}
        </div>
      )}
      {open.length > 0 && (
        <div
          data-testid="loop-questions-pointer"
          className="mt-0.5 text-description"
        >
          {open.length} open question{open.length === 1 ? "" : "s"}: answer them
          in the Questions panel above the input.
        </div>
      )}
      {standingNotes.length > 0 && (
        <ul
          data-testid="loop-standing-list"
          className="m-0 mt-1 list-none p-0 text-description"
        >
          {standingNotes.map((text, i) => (
            <li key={i} className="break-words">
              For every item: {text}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <input
          data-testid="loop-plan-note"
          value={note}
          maxLength={LOOP_LIMITS.maxAnswerLength}
          placeholder="A note about the whole plan (read at the next re-plan, or by every item)"
          onChange={(e) => setNote(e.target.value)}
          className="min-w-0 flex-1 basis-40 rounded border border-solid border-border bg-transparent px-1 text-xs text-foreground placeholder:text-description-muted"
        />
        <label className="flex shrink-0 items-center gap-0.5 text-description">
          <input
            type="checkbox"
            data-testid="loop-replan-now"
            checked={replanNow}
            onChange={(e) => {
              setReplanNow(e.target.checked);
              if (e.target.checked) setStanding(false);
            }}
          />
          Re-plan now
        </label>
        <label
          className="flex shrink-0 items-center gap-0.5 text-description"
          title="Send this with every item from now on, instead of waiting for the re-plan"
        >
          <input
            type="checkbox"
            data-testid="loop-standing"
            checked={standing}
            onChange={(e) => {
              setStanding(e.target.checked);
              if (e.target.checked) setReplanNow(false);
            }}
          />
          For every item
        </label>
        <button
          type="button"
          data-testid="loop-plan-note-send"
          disabled={!note.trim()}
          className="shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-1.5 text-xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50"
          onClick={async () => {
            const failed = await onAnswer({ text: note, replanNow, standing });
            setNoteError(failed);
            if (!failed) {
              setNote("");
              setReplanNow(false);
              setStanding(false);
            }
          }}
        >
          Add
        </button>
      </div>
      {noteError && (
        <div role="alert" className="mt-0.5 break-words text-error">
          {noteError}
        </div>
      )}
    </div>
  );
}
