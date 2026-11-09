import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { LoopAutonomy, LoopQuestion, LoopStrategy } from "core";
import {
  formatLoopStatus,
  LOOP_AUTONOMY,
  LOOP_AUTONOMY_LEVELS,
  LOOP_LIMITS,
  LOOP_MAX_PARALLEL,
  LOOP_STRATEGIES,
  LOOP_STRATEGY_ORDER,
  loopStrategy,
  standingInstructions,
} from "core/util/loopMode";
import { useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { LoopControls } from "./LoopControls";
import {
  answerLoopQuestion,
  endLoopThunk,
  LoopAnswerInput,
  resumeLoopThunk,
  setLoopAutonomyThunk,
  setLoopParallelThunk,
  setLoopStrategyThunk,
  stopLoopThunk,
} from "../../redux/thunks/loop";

const KIND_LABEL: Record<LoopQuestion["kind"], string> = {
  blocking: "Waiting on you",
  assumption: "Going on with a default",
  approval: "Needs your approval",
};

function QuestionRow({
  question,
  itemText,
  onAnswer,
}: {
  question: LoopQuestion;
  itemText?: string;
  onAnswer: (input: LoopAnswerInput) => Promise<string | undefined>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const answer = async (input: Omit<LoopAnswerInput, "questionId">) => {
    const failed = await onAnswer({ ...input, questionId: question.id });
    setError(failed);
    if (!failed) setText("");
  };
  return (
    <li
      data-testid={`loop-question-${question.id}`}
      className="border-border mt-1 rounded border border-solid px-1.5 py-1"
    >
      <div className="text-2xs text-description-muted">
        {question.id} · {KIND_LABEL[question.kind]}
        {itemText ? ` · ${itemText}` : ""}
      </div>
      <div className="text-foreground break-words">{question.question}</div>
      {question.assumption && (
        <div className="text-description break-words">
          Assumed: {question.assumption}
        </div>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        {question.kind === "approval" ? (
          <>
            <button
              type="button"
              data-testid="loop-approve"
              className="border-border text-foreground hover:bg-input cursor-pointer rounded border border-solid bg-transparent px-1.5 text-xs"
              onClick={() => void answer({ text: "", approve: true })}
            >
              Allow once
            </button>
            <button
              type="button"
              data-testid="loop-deny"
              className="border-border text-foreground hover:bg-input cursor-pointer rounded border border-solid bg-transparent px-1.5 text-xs"
              onClick={() => void answer({ text: text, approve: false })}
            >
              Don't allow
            </button>
          </>
        ) : (
          <>
            <input
              data-testid="loop-answer-input"
              value={text}
              maxLength={LOOP_LIMITS.maxAnswerLength}
              placeholder={
                question.kind === "assumption"
                  ? "Overrule with your answer"
                  : "Your answer"
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) {
                  e.preventDefault();
                  void answer({ text });
                }
              }}
              className="border-border bg-input text-foreground placeholder:text-description-muted min-w-0 flex-1 basis-32 rounded border border-solid px-1 text-xs"
            />
            <button
              type="button"
              data-testid="loop-answer-send"
              disabled={!text.trim()}
              className="border-border text-foreground hover:bg-input cursor-pointer rounded border border-solid bg-transparent px-1.5 text-xs disabled:cursor-default disabled:opacity-50"
              onClick={() => void answer({ text })}
            >
              Answer
            </button>
            {question.kind === "assumption" && (
              <button
                type="button"
                data-testid="loop-confirm"
                className="border-border text-foreground hover:bg-input cursor-pointer rounded border border-solid bg-transparent px-1.5 text-xs"
                onClick={() => void answer({ text: "", confirm: true })}
              >
                Keep the default
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <div role="alert" className="text-error mt-0.5 break-words">
          {error}
        </div>
      )}
    </li>
  );
}

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
  const itemText = (id?: string) =>
    taskPlan?.items.find((i) => i.id === id)?.text;
  const onAnswer = async (input: LoopAnswerInput) => {
    const result = await dispatch(answerLoopQuestion(input)).unwrap();
    return result.ok ? undefined : result.error;
  };
  const stopped = loop.status === "stopped";
  // Parallel waves need a level that does not ask before each edit
  const supervised = (loop.autonomy ?? "auto") === "supervised";
  const waveRunning = !!loop.parallel?.length;

  return (
    <div
      data-testid="loop-inbox"
      className="border-border mx-1 mb-1 min-w-0 rounded border border-solid px-2 py-1 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <ArrowPathIcon className="text-description h-3 w-3 shrink-0" />
        <span
          data-testid="loop-status"
          className="text-description min-w-0 flex-1 basis-40 break-words"
        >
          Loop · {formatLoopStatus(loop, { level: false })}
        </span>
        <select
          data-testid="loop-autonomy"
          value={loop.autonomy ?? "auto"}
          title={LOOP_AUTONOMY[loop.autonomy ?? "auto"].description}
          onChange={(e) =>
            void dispatch(setLoopAutonomyThunk(e.target.value as LoopAutonomy))
          }
          className="border-border bg-input text-foreground shrink-0 cursor-pointer rounded border border-solid px-1 text-xs"
        >
          {LOOP_AUTONOMY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {LOOP_AUTONOMY[level].label}
            </option>
          ))}
        </select>
        <select
          data-testid="loop-strategy"
          value={loopStrategy(loop)}
          title={LOOP_STRATEGIES[loopStrategy(loop)].description}
          onChange={(e) =>
            void dispatch(setLoopStrategyThunk(e.target.value as LoopStrategy))
          }
          className="border-border bg-input text-foreground shrink-0 cursor-pointer rounded border border-solid px-1 text-xs"
        >
          {LOOP_STRATEGY_ORDER.map((strategy) => (
            <option key={strategy} value={strategy}>
              {LOOP_STRATEGIES[strategy].label}
            </option>
          ))}
        </select>
        <label
          className="text-description flex shrink-0 items-center gap-0.5"
          title={
            supervised
              ? "Parallel waves run only at a level that does not ask before each edit"
              : `Run items with disjoint files: lines at the same time, up to ${LOOP_MAX_PARALLEL}, each in its own worktree; the change applies at the next step`
          }
        >
          <input
            type="checkbox"
            data-testid="loop-parallel"
            checked={!!loop.parallelOn}
            disabled={supervised}
            onChange={(e) =>
              void dispatch(setLoopParallelThunk(e.target.checked))
            }
          />
          Parallel
        </label>
        {stopped ? (
          <>
            {loop.stopReason !== "done" && (
              <button
                type="button"
                data-testid="loop-resume"
                className="text-link shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs hover:underline"
                onClick={() => void dispatch(resumeLoopThunk())}
              >
                Resume
              </button>
            )}
            <button
              type="button"
              data-testid="loop-end"
              className="text-description-muted hover:text-foreground shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs"
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
                title={
                  waveRunning
                    ? "Stop the wave's workers now; their items go back to pending"
                    : "Stop once the running item or re-plan ends"
                }
                className="text-link shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs hover:underline"
                onClick={() => void dispatch(stopLoopThunk())}
              >
                {waveRunning ? "Stop the wave" : "Stop after this item"}
              </button>
            )}
            {loop.current && (
              <button
                type="button"
                data-testid="loop-stop-now"
                title="Stop the running item now; it goes back to pending"
                className="text-link shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs hover:underline"
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
          className="text-description mt-0.5 truncate"
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
          className="text-description mt-0.5"
        >
          New plan waiting on its card: {loop.replanReason}
        </div>
      )}
      {open.length > 0 && (
        <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
          {open.map((q) => (
            <QuestionRow
              key={q.id}
              question={q}
              itemText={itemText(q.itemId)}
              onAnswer={onAnswer}
            />
          ))}
        </ul>
      )}
      {standingNotes.length > 0 && (
        <ul
          data-testid="loop-standing-list"
          className="text-description m-0 mt-1 list-none p-0"
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
          className="border-border text-foreground placeholder:text-description-muted min-w-0 flex-1 basis-40 rounded border border-solid bg-transparent px-1 text-xs"
        />
        <label className="text-description flex shrink-0 items-center gap-0.5">
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
          className="text-description flex shrink-0 items-center gap-0.5"
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
          className="border-border text-foreground hover:bg-input shrink-0 cursor-pointer rounded border border-solid bg-transparent px-1.5 text-xs disabled:cursor-default disabled:opacity-50"
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
        <div role="alert" className="text-error mt-0.5 break-words">
          {noteError}
        </div>
      )}
    </div>
  );
}
