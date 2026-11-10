import { createLoop, startItemRun } from "core/util/loopMode";
import { describe, expect, it, vi } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import { addItemBudgetNote, endRunAtTurnLimit } from "./loopHolds";

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

/** A running item 1 with `used` tokens since it started, and its report. */
function setup(used: number, report?: boolean, itemId = "1") {
  const state = getEmptyRootState();
  const base = startItemRun(
    createLoop(PLAN, { now: NOW, sessionTokens: 0 }),
    itemId,
    0,
    NOW,
    { sessionTokens: 0 },
  );
  const loop = report
    ? {
        ...base,
        current: {
          ...base.current!,
          report: { outcome: "done" as const, summary: "done it" },
        },
      }
    : base;
  let current: RootState = {
    ...state,
    session: {
      ...state.session,
      loop,
      history: [],
      taskPlan: PLAN,
      usage: { promptTokens: used, completionTokens: 0 } as any,
    },
  };
  const dispatch = vi.fn((action: any) => {
    if (action.type === "session/setLoop") {
      current = {
        ...current,
        session: { ...current.session, loop: action.payload },
      };
    }
    return action;
  });
  return { dispatch, getState: () => current };
}

describe("endRunAtTurnLimit and an item's own budget", () => {
  it("ends a run that has used more than its item's budget, with the figures", () => {
    const { dispatch, getState } = setup(12_000);
    expect(endRunAtTurnLimit(dispatch as any, getState)).toBe(true);
    const current = getState().session.loop!.current!;
    expect(current.overBudget).toEqual({
      which: "tokens",
      used: 12_000,
      limit: 10_000,
    });
    expect(current.report?.summary).toContain("Over budget");
    expect(current.report?.summary).toContain("12,000 of its 10,000 tokens");
  });

  it("lets a run under its budget go on", () => {
    const { dispatch, getState } = setup(7_000);
    expect(endRunAtTurnLimit(dispatch as any, getState)).toBe(false);
    expect(getState().session.loop!.current!.overBudget).toBeUndefined();
  });

  it("does not override a report the run already made", () => {
    const { dispatch, getState } = setup(50_000, true);
    expect(endRunAtTurnLimit(dispatch as any, getState)).toBe(false);
    expect(getState().session.loop!.current!.report?.outcome).toBe("done");
  });

  it("leaves an item with no budget alone", () => {
    const { dispatch, getState } = setup(900_000, false, "2");
    expect(endRunAtTurnLimit(dispatch as any, getState)).toBe(false);
  });
});

describe("addItemBudgetNote", () => {
  function withToolCall(used: number, told?: boolean) {
    const { dispatch, getState } = setup(used);
    const state = getState();
    const loop = state.session.loop!;
    const toolCall = {
      toolCallId: "tc1",
      toolCall: {
        id: "tc1",
        type: "function",
        function: { name: "x", arguments: "{}" },
      },
      status: "done",
      output: [{ name: "r", description: "r", content: "result" }],
    };
    const current: RootState = {
      ...state,
      session: {
        ...state.session,
        loop: told
          ? { ...loop, current: { ...loop.current!, budgetWarned: ["tokens"] } }
          : loop,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [toolCall],
          } as any,
        ],
      },
    };
    const calls: any[] = [];
    const d = vi.fn((action: any) => {
      calls.push(action);
      return dispatch(action);
    });
    return { d, calls, getState: () => current };
  }

  it("appends one line to the last tool result at 80% and records it", () => {
    const { d, calls, getState } = withToolCall(8_500);
    expect(addItemBudgetNote(d as any, getState, "tc1")).toBe(true);
    const output = calls.find((a) => a.type === "session/updateToolCallOutput");
    expect(output.payload.contextItems).toHaveLength(2);
    expect(output.payload.contextItems[0].content).toBe("result");
    expect(output.payload.contextItems[1].content).toContain(
      "80% of its tokens",
    );
    const set = calls.find((a) => a.type === "session/setLoop");
    expect(set.payload.current.budgetWarned).toEqual(["tokens"]);
  });

  it("says nothing below 80%, once told, or over the limit", () => {
    for (const [used, told] of [
      [7_000, false],
      [8_500, true],
      [12_000, false],
    ] as const) {
      const { d, calls, getState } = withToolCall(used, told);
      expect(addItemBudgetNote(d as any, getState, "tc1")).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
});
