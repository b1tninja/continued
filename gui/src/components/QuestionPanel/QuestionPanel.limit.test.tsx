import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { LoopState } from "core";
import { overBudgetReport } from "core/util/itemBudget";
import { applyLimitPolicy } from "core/util/itemBudgetPolicy";
import { createLoop, finishItemRun, startItemRun } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  setTaskPlan,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { QuestionPanel } from "./QuestionPanel";

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

/** A loop whose item 1 ran over its budget, with the Suggest question open. */
function askedLoop(): LoopState {
  let loop: LoopState = {
    ...createLoop(PLAN, { now: NOW, sessionTokens: 0, autonomy: "supervised" }),
    reserve: { tokens: 40_000 },
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
  const decision = applyLimitPolicy(
    loop,
    { id: "1", budget: PLAN.items[0].budget },
    { now: NOW },
  );
  if (decision?.kind !== "ask") throw new Error("not asked");
  return decision.loop;
}

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<QuestionPanel />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "Loop",
        workspaceDirectory: "",
        history: [],
        mode: "agent",
      }),
    );
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(askedLoop()));
  });
  return { store };
}

describe("a budget question in the Questions panel", () => {
  it("offers the four choices, which are selected first and applied with Answer", async () => {
    const { store } = await setup();
    const options = screen.getAllByTestId("loop-choice-option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Extend",
      "Split",
      "Skip",
      "Block",
    ]);
    // Selecting answers nothing
    fireEvent.click(options[0]);
    expect(store.getState().session.loop?.items[0].status).toBe("waiting");
    expect(store.getState().session.taskPlan?.items[0].budget?.tokens).toBe(
      10_000,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("loop-choice-apply"));
    });
    await waitFor(() =>
      expect(store.getState().session.loop?.items[0].status).toBe("pending"),
    );
    // Extended from the reserve: the plan's number went up and the panel is gone
    expect(store.getState().session.taskPlan?.items[0].budget?.tokens).toBe(
      15_000,
    );
    expect(store.getState().session.loop?.reserve?.tokens).toBe(35_000);
    expect(screen.queryByTestId("question-panel")).toBeNull();
  });

  it("Skip finishes the item as skipped", async () => {
    const { store } = await setup();
    fireEvent.click(screen.getAllByTestId("loop-choice-option")[2]);
    await act(async () => {
      fireEvent.click(screen.getByTestId("loop-choice-apply"));
    });
    await waitFor(() =>
      expect(store.getState().session.loop?.items[0].skipped).toBe(true),
    );
  });

  it("a written answer under Other is refused and the question stays", async () => {
    const { store } = await setup();
    fireEvent.click(screen.getByTestId("loop-choice-other"));
    fireEvent.change(screen.getByTestId("loop-choice-other-input"), {
      target: { value: "do whatever" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("loop-choice-apply"));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Choose one of");
    expect(
      store.getState().session.loop?.questions[0].answerId,
    ).toBeUndefined();
  });
});
