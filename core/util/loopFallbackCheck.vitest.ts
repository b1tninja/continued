import { describe, expect, test } from "vitest";
import type { LoopState, TaskPlan } from "../index.js";
import {
  createLoop,
  decideNext,
  finishItemRun,
  itemCheck,
  LOOP_FALLBACK_CHECK_LENGTH,
  loopItemPrompt,
  loopPlanBlock,
  reconcileLoop,
  recordCheck,
  setLoopFallbackCheck,
  startCheck,
  startItemRun,
  taskPlanWithLoop,
} from "./loopMode.js";

/*
 * The loop's fallback check: an item with no `check:` of its own is held to
 * one command the harness runs after the item reports done, so "done" is
 * not the agent's word alone. Off unless a command is set.
 */

const T0 = new Date("2026-11-10T10:00:00Z");
const ctx = { now: T0, sessionTokens: 0 };

const plan: TaskPlan = {
  items: [
    { id: "1", text: "Own check", status: "pending", check: "npm test -- own" },
    { id: "2", text: "No check", status: "pending" },
  ],
  updatedAt: T0.toISOString(),
};

const withFallback = (command = "npm test"): LoopState =>
  createLoop(plan, { now: T0, sessionTokens: 0, fallbackCheck: command });

/** Item `id` runs and reports done, the way a host finishes it. */
function reportDone(loop: LoopState, id: string): LoopState {
  const task = plan.items.find((t) => t.id === id)!;
  return finishItemRun(
    startItemRun(loop, id, 0, T0),
    { outcome: "done", summary: "did it" },
    { check: itemCheck(loop, task) },
  );
}

describe("itemCheck", () => {
  test("an item's own check wins, the fallback fills in, and neither is none", () => {
    const loop = withFallback();
    expect(itemCheck(loop, plan.items[0])).toBe("npm test -- own");
    expect(itemCheck(loop, plan.items[1])).toBe("npm test");
    const off = createLoop(plan, { now: T0, sessionTokens: 0 });
    expect(itemCheck(off, plan.items[1])).toBeUndefined();
  });

  test("is off by default, and a blank or over-long command sets nothing", () => {
    expect(
      createLoop(plan, { now: T0, sessionTokens: 0 }).fallbackCheck,
    ).toBeUndefined();
    expect(withFallback("   ").fallbackCheck).toBeUndefined();
    expect(
      withFallback("x".repeat(LOOP_FALLBACK_CHECK_LENGTH + 1)).fallbackCheck,
    ).toBeUndefined();
    expect(withFallback("  npm test ").fallbackCheck).toBe("npm test");
  });
});

describe("a done report on an item without a check of its own", () => {
  test("waits for the fallback check, which the harness runs", () => {
    const loop = reportDone(withFallback(), "2");
    expect(loop.items[1].status).toBe("checking");
    expect(decideNext(loop, plan, ctx)).toEqual({
      kind: "check",
      itemId: "2",
      command: "npm test",
    });
  });

  test("is done at once without the setting, as before", () => {
    const loop = reportDone(
      createLoop(plan, { now: T0, sessionTokens: 0 }),
      "2",
    );
    expect(loop.items[1].status).toBe("done");
  });

  test("passes on exit 0 and goes back for another attempt on a failure", () => {
    const checking = startCheck(reportDone(withFallback(), "2"), "2", 0, T0);
    const passed = recordCheck(
      checking,
      { status: "passed", command: "npm test", exitCode: 0 },
      T0,
    );
    expect(passed.items[1].status).toBe("done");
    const failed = recordCheck(
      checking,
      {
        status: "failed",
        command: "npm test",
        exitCode: 1,
        output: "1 failed",
      },
      T0,
    );
    expect(failed.items[1].status).toBe("pending");
    expect(failed.items[1].summary).toContain("npm test");
  });

  test("an item's own check still runs instead of the fallback", () => {
    const loop = reportDone(withFallback(), "1");
    expect(decideNext(loop, plan, ctx)).toMatchObject({
      kind: "check",
      command: "npm test -- own",
    });
  });
});

describe("setLoopFallbackCheck", () => {
  test("sets, replaces and clears it; an over-long command changes nothing", () => {
    const base = createLoop(plan, { now: T0, sessionTokens: 0 });
    const set = setLoopFallbackCheck(base, " pnpm test ");
    expect(set.fallbackCheck).toBe("pnpm test");
    expect(setLoopFallbackCheck(set, "").fallbackCheck).toBeUndefined();
    expect(
      setLoopFallbackCheck(set, "y".repeat(LOOP_FALLBACK_CHECK_LENGTH + 1)),
    ).toBe(set);
  });

  test("clearing it settles an item that waited on it as done", () => {
    const checking = reportDone(withFallback(), "2");
    expect(checking.items[1].status).toBe("checking");
    const cleared = reconcileLoop(setLoopFallbackCheck(checking, ""), plan);
    expect(cleared.items[1].status).toBe("done");
  });
});

describe("what the model and the person see", () => {
  test("the item prompt tells the model which command will run", () => {
    const prompt = loopItemPrompt({
      item: plan.items[1],
      answers: [],
      questions: [],
      attempt: 1,
      fallbackCheck: "npm test",
    });
    expect(prompt).toContain("its check runs: `npm test`");
    const none = loopItemPrompt({
      item: plan.items[1],
      answers: [],
      questions: [],
      attempt: 1,
    });
    expect(none).not.toContain("its check runs");
  });

  test("the plan block and the task list show it, marked as the loop's own", () => {
    const loop = startItemRun(withFallback(), "2", 0, T0);
    const block = loopPlanBlock({ loop, plan });
    expect(block).toContain(
      "check: npm test (the loop's check for every item)",
    );
    // An item's own check is not labelled
    expect(block).toContain("check: npm test -- own\n");
    const checking = reportDone(withFallback(), "2");
    expect(taskPlanWithLoop(plan, checking).items[1].note).toBe(
      "Checking: npm test",
    );
  });
});
