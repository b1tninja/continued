import { createAsyncThunk } from "@reduxjs/toolkit";
import { LoopState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  acceptReplan,
  answerLoop,
  answersToDeliver,
  createLoop,
  decideNext,
  finishItemRun,
  loopItemPrompt,
  loopReplanPrompt,
  markDelivered,
  planAddsScope,
  reconcileLoop,
  requestStop,
  resumeLoop,
  settleSteeredAnswers,
  startItemRun,
  startReplan,
  stopLoop,
} from "core/util/loopMode";
import { parsePlanFile, taskPlanFromPlanFile } from "core/util/planFile";
import { findUriInDirs } from "core/util/uri";
import { selectAutoApproval } from "../selectors/selectAutoApproval";
import {
  enqueueMessage,
  removeQueuedMessage,
  setLoop,
  setMode,
  setTaskPlan,
} from "../slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { commitLoop } from "../util/loopCommit";

import { streamResponseThunk } from "./streamResponse";

/**
 * Loop mode in the gui: the thunks that start, advance, answer and stop the
 * loop. The decisions are core's (core/util/loopMode.ts); these apply them to
 * the session and send the turns. useLoopDriver calls advanceLoop whenever
 * nothing is running. Design: plans/loop-mode.md.
 */

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function sessionTokens(state: RootState): number {
  const usage = state.session.usage;
  return usage ? usage.promptTokens + usage.completionTokens : 0;
}

async function displayPath(
  fileUri: string | undefined,
  getWorkspaceDirs: () => Promise<string[]>,
): Promise<string | undefined> {
  if (!fileUri) return undefined;
  try {
    const { relativePathOrBasename, foundInDir } = findUriInDirs(
      fileUri,
      await getWorkspaceDirs(),
    );
    return foundInDir ? relativePathOrBasename : fileUri;
  } catch {
    return fileUri;
  }
}

async function sendLoopTurn(dispatch: AppThunkDispatch, text: string) {
  await dispatch(
    streamResponseThunk({
      editorState: doc(text),
      modifiers: { noContext: true, useCodebase: false },
    }),
  );
}

/** Reads the plan file back (the person may have edited it) into the task list. */
async function readPlanIntoTaskList(
  planFile: string,
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  readFile: (uri: string) => Promise<string>,
): Promise<{ title?: string }> {
  try {
    const markdown = await readFile(planFile);
    const result = taskPlanFromPlanFile(markdown, getState().session.taskPlan);
    if (result.ok) {
      dispatch(setTaskPlan(result.plan));
      return { title: result.title };
    }
    console.warn(`Plan file to-dos not used: ${result.error}`);
  } catch (e) {
    console.warn("Could not read the plan file", e);
  }
  return {};
}

/** "Build in a loop" on a plan card: seed the loop from the plan's to-dos. */
export const startLoopFromPlan = createAsyncThunk<
  void,
  { planFile: string },
  ThunkApiType
>("loop/start", async ({ planFile }, { dispatch, getState, extra }) => {
  await readPlanIntoTaskList(planFile, dispatch, getState, (uri) =>
    extra.ideMessenger.ide.readFile(uri),
  );
  const plan = getState().session.taskPlan;
  if (!plan) return;
  const loop = createLoop(plan, {
    now: new Date(),
    sessionTokens: sessionTokens(getState()),
  });
  dispatch(setMode("agent"));
  commitLoop(dispatch, getState, loop);
});

/** The loop's re-plan card: accept it and start the next round. */
export const acceptLoopPlan = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/acceptPlan",
  async (_, { dispatch, getState, extra }) => {
    const { loop, planFile } = getState().session;
    if (!loop || loop.status !== "awaiting_plan") return;
    if (planFile) {
      await readPlanIntoTaskList(planFile, dispatch, getState, (uri) =>
        extra.ideMessenger.ide.readFile(uri),
      );
    }
    const plan = getState().session.taskPlan;
    if (!plan) return;
    dispatch(setMode("agent"));
    commitLoop(
      dispatch,
      getState,
      acceptReplan(loop, plan, {
        now: new Date(),
        sessionTokens: sessionTokens(getState()),
      }),
    );
  },
);

export const stopLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/stop",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop || loop.status === "stopped") return;
    commitLoop(dispatch, getState, requestStop(loop));
  },
);

export const resumeLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/resume",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop || loop.status !== "stopped") return;
    commitLoop(
      dispatch,
      getState,
      resumeLoop(loop, {
        now: new Date(),
        sessionTokens: sessionTokens(getState()),
      }),
    );
  },
);

/** Ends the loop and forgets it (the task list stays). */
export const endLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/end",
  async (_, { dispatch }) => {
    dispatch(setLoop(undefined));
  },
);

export interface LoopAnswerInput {
  questionId?: string;
  itemId?: string;
  text: string;
  confirm?: boolean;
  approve?: boolean;
  replanNow?: boolean;
}

/**
 * The person answered from the inbox. Core routes it by the item's state; an
 * answer for the running item is queued as a steered message, so it reaches
 * the model at its next tool boundary without stopping the turn.
 */
export const answerLoopQuestion = createAsyncThunk<
  { ok: boolean; error?: string },
  LoopAnswerInput,
  ThunkApiType
>("loop/answer", async (input, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop) return { ok: false, error: "No loop is running" };
  const result = answerLoop(loop, input, new Date());
  if (!result.ok) return result;
  const { answer } = result;
  commitLoop(dispatch, getState, result.loop);
  if (answer.route === "steer") {
    const question = result.loop.questions.find(
      (q) => q.id === answer.questionId,
    );
    const text = question
      ? `The person answered your question ${question.id} ("${question.question}"): ${answer.text}`
      : `A note from the person about this item: ${answer.text}`;
    dispatch(
      enqueueMessage({
        editorState: doc(text),
        modifiers: { noContext: true, useCodebase: false },
        steer: true,
        loopAnswerId: answer.id,
      }),
    );
  }
  return { ok: true };
});

/** The finish_item and present_plan calls made since a run started. */
function callsSince(state: RootState, historyIndex: number, name: string) {
  return state.session.history
    .slice(historyIndex)
    .flatMap((item) => item.toolCallStates ?? [])
    .filter((tc) => tc.toolCall.function.name === name);
}

/**
 * One step of the loop, run when nothing is streaming: finish what ran, then
 * decide what is next and start it. Resolves when the turn it started ends.
 */
export const advanceLoop = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/advance",
  async (_, { dispatch, getState, extra }) => {
    const ide = extra.ideMessenger.ide;
    let state = getState();
    let loop = state.session.loop;
    if (!loop || loop.status === "stopped" || loop.status === "awaiting_plan") {
      return;
    }
    const now = new Date();

    // 1. Finish what ran.
    if (loop.current?.kind === "item") {
      const queuedIds = new Set(
        state.session.queuedMessages
          .map((m) => m.loopAnswerId)
          .filter((id): id is string => !!id),
      );
      // Steered answers still queued did not reach the run
      for (const m of state.session.queuedMessages) {
        if (m.loopAnswerId) dispatch(removeQueuedMessage(m.id));
      }
      const delivered = loop.answers
        .filter((a) => a.route === "steer" && !queuedIds.has(a.id))
        .map((a) => a.id);
      loop = finishItemRun(loop, loop.current.report);
      loop = settleSteeredAnswers(loop, delivered);
    } else if (loop.current?.kind === "replan") {
      const presented = callsSince(
        state,
        loop.current.historyIndex,
        BuiltInToolNames.PresentPlan,
      ).some((tc) => tc.status === "done");
      const planTexts = loop.current.planTexts ?? [];
      if (!presented) {
        commitLoop(
          dispatch,
          getState,
          stopLoop(
            loop,
            "replan_failed",
            "The re-plan ended without presenting a plan.",
          ),
        );
        return;
      }
      loop = { ...loop, current: undefined, status: "awaiting_plan" };
      commitLoop(dispatch, getState, loop);
      const plan = getState().session.taskPlan;
      // Auto accepts a re-plan that adds no new work; anything else waits
      // for the person on the plan card.
      if (
        plan &&
        selectAutoApproval(getState()).active &&
        !planAddsScope(planTexts, plan)
      ) {
        await dispatch(acceptLoopPlan());
      }
      return;
    }

    // 2. Decide what is next.
    state = getState();
    const plan = state.session.taskPlan;
    if (!plan) {
      commitLoop(
        dispatch,
        getState,
        stopLoop(loop, "done", "The task list is empty."),
      );
      return;
    }
    loop = reconcileLoop(loop, plan);
    const action = decideNext(loop, plan, {
      now,
      sessionTokens: sessionTokens(state),
    });
    const planFile = await displayPath(state.session.planFile, () =>
      ide.getWorkspaceDirs(),
    );

    switch (action.kind) {
      case "none":
        commitLoop(dispatch, getState, loop);
        return;
      case "wait":
        commitLoop(dispatch, getState, { ...loop, status: "waiting" });
        return;
      case "stop":
        commitLoop(
          dispatch,
          getState,
          stopLoop(loop, action.reason, action.detail),
        );
        return;
      case "run": {
        const item = plan.items.find((i) => i.id === action.itemId)!;
        const itemState = loop.items.find((i) => i.id === action.itemId);
        const answers = answersToDeliver(loop, action.itemId);
        const prompt = loopItemPrompt({
          item,
          planFile,
          answers,
          questions: loop.questions,
          redo: itemState?.status === "redo",
          attempt: (itemState?.attempts ?? 0) + 1,
        });
        loop = markDelivered(
          loop,
          answers.map((a) => a.id),
        );
        loop = startItemRun(
          loop,
          action.itemId,
          state.session.history.length,
          now,
        );
        dispatch(setMode("agent"));
        commitLoop(dispatch, getState, loop);
        await sendLoopTurn(dispatch, prompt);
        return;
      }
      case "replan": {
        let planTitle: string | undefined;
        if (state.session.planFile) {
          try {
            planTitle = parsePlanFile(
              await ide.readFile(state.session.planFile),
            ).title;
          } catch {
            // the prompt goes without a title
          }
        }
        const prompt = loopReplanPrompt({ loop, plan, planFile, planTitle });
        const next = startReplan(loop, state.session.history.length, now);
        loop = {
          ...next,
          current: next.current && {
            ...next.current,
            planTexts: plan.items.map((i) => i.text),
          },
        };
        dispatch(setMode("plan"));
        commitLoop(dispatch, getState, loop);
        await sendLoopTurn(dispatch, prompt);
        return;
      }
    }
  },
);
