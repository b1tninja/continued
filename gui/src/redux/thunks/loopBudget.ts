import { createAsyncThunk } from "@reduxjs/toolkit";
import type { LoopState } from "core";
import {
  answerLimitQuestion,
  applyLimitPolicy,
  type LimitPolicy,
} from "core/util/itemBudgetPolicy";
import type { ItemBudget } from "core/util/itemBudget";
import {
  applyPlanBudgets,
  computePlanBudgets,
  plannerBudgetsApply,
  setupByItemId,
  type PlanBudgetSetup,
} from "core/util/planBudget";
import { setTaskPlan } from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { commitLoop } from "../util/loopCommit";

/**
 * The loop's budgets in the gui: what the plan card's budget step writes
 * into the plan when the loop starts, and what happens when an item runs out
 * of its own budget (core/util/itemBudgetPolicy.ts). The decisions are
 * core's; these apply them to the session.
 */

/** Writes one item's new budget into the session's task list. */
function setItemBudget(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  itemId: string,
  budget: ItemBudget,
) {
  const plan = getState().session.taskPlan;
  if (!plan) return;
  dispatch(setTaskPlan(applyPlanBudgets(plan, { [itemId]: budget })));
}

/**
 * Applies the plan card's budget step to a plan being turned into a loop:
 * the budgets go into the task list and the reserve onto the loop. Without a
 * step (Skip) the strategy is None, and at Manual the planner's own
 * `budget:` lines are dropped: nothing applies without the person.
 */
export function applyBudgetStep(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  loop: LoopState,
  setup: PlanBudgetSetup | undefined,
): LoopState {
  const state = getState();
  const plan = state.session.taskPlan;
  if (!plan) return loop;
  const level = loop.policy?.plan ?? "cautious";
  const planner = plannerBudgetsApply(level) || !!setup;
  const result = computePlanBudgets(
    plan.items.map((item) => ({ id: item.id, budget: item.budget })),
    loop.budget,
    setup
      ? setupByItemId(
          setup,
          plan.items.map((item) => item.id),
        )
      : { strategy: "none", reserve: 0 },
    { plannerBudgets: planner },
  );
  dispatch(setTaskPlan(applyPlanBudgets(plan, result.budgets)));
  return Object.keys(result.reserve).length > 0
    ? { ...loop, reserve: result.reserve }
    : loop;
}

/**
 * After an item's run ended: when it ran over its own budget, the limit
 * policy decides. Returns the loop to commit; an extension also writes the
 * item's new budget to the task list. Review has no progress evidence in the
 * gui yet (the stuck signals are not wired to it), so it extends nothing.
 */
export function applyLimitAfterRun(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  loop: LoopState,
  itemId: string,
): LoopState {
  const item = getState().session.taskPlan?.items.find((i) => i.id === itemId);
  if (!item) return loop;
  const decision = applyLimitPolicy(
    loop,
    { id: item.id, budget: item.budget },
    { now: new Date() },
  );
  if (!decision) return loop;
  if (decision.kind === "extend") {
    setItemBudget(dispatch, getState, itemId, decision.budget);
  }
  return decision.loop;
}

/** The person's choice on a budget question: Extend, Split, Skip or Block. */
export const answerLimitQuestionThunk = createAsyncThunk<
  { ok: boolean; error?: string },
  { questionId: string; choice: string },
  ThunkApiType
>(
  "loop/answerLimit",
  async ({ questionId, choice }, { dispatch, getState }) => {
    const { loop, taskPlan } = getState().session;
    if (!loop) return { ok: false, error: "No loop is running" };
    const itemId = loop.questions.find((q) => q.id === questionId)?.itemId;
    const item = taskPlan?.items.find((i) => i.id === itemId);
    if (!item) return { ok: false, error: "The item is not in the plan" };
    const result = answerLimitQuestion(
      loop,
      { id: item.id, budget: item.budget },
      questionId,
      choice,
      new Date(),
    );
    if (!result.ok) return result;
    if (result.budget)
      setItemBudget(dispatch, getState, item.id, result.budget);
    commitLoop(dispatch, getState, result.loop);
    return { ok: true };
  },
);

/** The loop's setting for what happens at an item's limit. */
export const setLimitPolicyThunk = createAsyncThunk<
  void,
  LimitPolicy,
  ThunkApiType
>("loop/setLimitPolicy", async (policy, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop) return;
  commitLoop(dispatch, getState, { ...loop, limitPolicy: policy });
});
