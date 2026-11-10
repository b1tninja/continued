import type { LoopState } from "core";
import { overBudgetReport } from "core/util/itemBudget";
import { createLoop, finishItemRun, startItemRun } from "core/util/loopMode";
import { describe, expect, it, vi } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import {
  answerLimitQuestionThunk,
  applyBudgetStep,
  applyLimitAfterRun,
} from "./loopBudget";

const NOW = new Date("2026-11-09T10:00:00Z");
const PLAN = {
  items: [
    {
      id: "1",
      text: "Fix it",
      status: "pending" as const,
      budget: { tokens: 10_000 },
    },
    { id: "2", text: "Ship it", status: "pending" as const },
  ],
  updatedAt: NOW.toISOString(),
};
const BREACH = { which: "tokens" as const, used: 11_000, limit: 10_000 };

/** A store whose loop has just ended item 1 over its token budget. */
function overBudget(extra: Partial<LoopState> = {}) {
  let loop: LoopState = {
    ...createLoop(PLAN, { now: NOW, sessionTokens: 0, autonomy: "auto" }),
    ...extra,
  };
  loop = startItemRun(loop, "1", 0, NOW, { sessionTokens: 0 });
  loop = {
    ...loop,
    current: {
      ...loop.current!,
      overBudget: BREACH,
      report: overBudgetReport(BREACH),
    },
  };
  loop = finishItemRun(loop, loop.current!.report, {
    sessionTokens: 11_000,
    now: new Date(NOW.getTime() + 60_000),
  });
  const state = getEmptyRootState();
  let current: RootState = {
    ...state,
    session: { ...state.session, loop, history: [], taskPlan: PLAN },
  };
  const dispatch = vi.fn((action: any) => {
    if (action.type === "session/setLoop") {
      current = {
        ...current,
        session: { ...current.session, loop: action.payload },
      };
    }
    if (action.type === "session/setTaskPlan") {
      current = {
        ...current,
        session: { ...current.session, taskPlan: action.payload },
      };
    }
    return action;
  });
  return { dispatch, getState: () => current, loop };
}

describe("applyLimitAfterRun", () => {
  it("does nothing for an item that did not run over", () => {
    const { dispatch, getState, loop } = overBudget();
    expect(applyLimitAfterRun(dispatch as any, getState, loop, "2")).toBe(loop);
  });

  it("Force leaves the item failed and the loop as it was", () => {
    const { dispatch, getState, loop } = overBudget({ limitPolicy: "force" });
    const next = applyLimitAfterRun(dispatch as any, getState, loop, "1");
    expect(next.items[0].status).toBe("failed");
    expect(next.questions).toHaveLength(0);
  });

  it("Suggest holds a question and the item waits on it", () => {
    const { dispatch, getState, loop } = overBudget({
      limitPolicy: "suggest",
      reserve: { tokens: 40_000 },
    });
    const next = applyLimitAfterRun(dispatch as any, getState, loop, "1");
    expect(next.items[0].status).toBe("waiting");
    expect(next.questions[0].options).toEqual([
      "Extend",
      "Split",
      "Skip",
      "Block",
    ]);
  });

  it("Review without progress evidence stops: it extends nothing on faith", () => {
    const { dispatch, getState, loop } = overBudget({
      limitPolicy: "review",
      reserve: { tokens: 40_000 },
    });
    const next = applyLimitAfterRun(dispatch as any, getState, loop, "1");
    expect(next.items[0].status).toBe("failed");
    expect(next.reserve?.tokens).toBe(40_000);
  });
});

describe("answerLimitQuestionThunk", () => {
  async function ask() {
    const h = overBudget({
      limitPolicy: "suggest",
      reserve: { tokens: 40_000 },
    });
    const asked = applyLimitAfterRun(
      h.dispatch as any,
      h.getState,
      h.loop,
      "1",
    );
    h.dispatch({ type: "session/setLoop", payload: asked });
    return { ...h, id: asked.questions[0].id };
  }
  const run = (
    h: Awaited<ReturnType<typeof ask>>,
    choice: string,
    questionId = h.id,
  ) =>
    answerLimitQuestionThunk({ questionId, choice })(
      h.dispatch as any,
      h.getState,
      {} as any,
    );

  it("Extend raises the item's budget in the plan and draws the reserve down", async () => {
    const h = await ask();
    const result = await run(h, "Extend");
    expect(result.payload).toEqual({ ok: true });
    const { loop, taskPlan } = h.getState().session;
    expect(taskPlan?.items[0].budget?.tokens).toBe(15_000);
    expect(loop?.reserve?.tokens).toBe(35_000);
    expect(loop?.items[0].status).toBe("pending");
  });

  it("a written answer is refused and nothing changes", async () => {
    const h = await ask();
    const result = await run(h, "just carry on");
    expect(result.payload).toMatchObject({ ok: false });
    expect(h.getState().session.taskPlan?.items[0].budget?.tokens).toBe(10_000);
    expect(h.getState().session.loop?.items[0].status).toBe("waiting");
  });

  it("Skip finishes the item as skipped", async () => {
    const h = await ask();
    await run(h, "Skip");
    expect(h.getState().session.loop?.items[0]).toMatchObject({
      status: "done",
      skipped: true,
    });
  });
});

describe("applyBudgetStep", () => {
  function started(level: "manual" | "cautious") {
    const state = getEmptyRootState();
    let current: RootState = {
      ...state,
      session: { ...state.session, history: [], taskPlan: PLAN },
    };
    const dispatch = vi.fn((action: any) => {
      if (action.type === "session/setTaskPlan") {
        current = {
          ...current,
          session: { ...current.session, taskPlan: action.payload },
        };
      }
      return action;
    });
    const loop = createLoop(PLAN, {
      now: NOW,
      sessionTokens: 0,
      policy: { plan: level, questions: level },
    });
    return { dispatch, getState: () => current, loop };
  }

  it("keeps the planner's line below Manual, and a Skip adds nothing", () => {
    const h = started("cautious");
    const loop = applyBudgetStep(
      h.dispatch as any,
      h.getState,
      h.loop,
      undefined,
    );
    expect(h.getState().session.taskPlan?.items[0].budget).toEqual({
      tokens: 10_000,
    });
    expect(loop.reserve).toBeUndefined();
  });

  it("drops it at Manual unless the person applied the step", () => {
    const skipped = started("manual");
    applyBudgetStep(
      skipped.dispatch as any,
      skipped.getState,
      skipped.loop,
      undefined,
    );
    expect(
      skipped.getState().session.taskPlan?.items[0].budget,
    ).toBeUndefined();

    const applied = started("manual");
    applyBudgetStep(applied.dispatch as any, applied.getState, applied.loop, {
      strategy: "none",
      reserve: 0,
    });
    expect(applied.getState().session.taskPlan?.items[0].budget).toEqual({
      tokens: 10_000,
    });
  });

  it("divides by position-keyed numbers and sets the reserve on the loop", () => {
    const h = started("cautious");
    const loop = applyBudgetStep(h.dispatch as any, h.getState, h.loop, {
      strategy: "equal",
      reserve: 0.2,
      overrides: { "2": { tokens: 70_000 } },
    });
    const items = h.getState().session.taskPlan!.items;
    expect(items[1].budget?.tokens).toBe(70_000);
    expect(loop.reserve?.tokens).toBe(
      Math.floor(h.loop.budget.maxTokens * 0.2),
    );
  });
});
