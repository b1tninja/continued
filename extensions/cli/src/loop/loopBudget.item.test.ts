import type { TaskPlan } from "core/index.js";
import { createLoop, startItemRun } from "core/util/loopMode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { services } from "../services/index.js";
import {
  createSession,
  getSessionLoop,
  updateSessionLoop,
  updateSessionTaskPlan,
} from "../session.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import {
  endItemRunOverBudget,
  itemBudgetNoteNow,
  itemRunTurns,
} from "./loopBudget.js";

const NOW = new Date("2026-11-10T00:00:00Z");

function plan(budget: { turns?: number; minutes?: number }): TaskPlan {
  return {
    items: [
      { id: "1", text: "Lexer", status: "pending", budget },
      { id: "2", text: "Parser", status: "pending" },
    ],
    updatedAt: NOW.toISOString(),
  };
}

/** A running item 1 whose run started at history index `at`. */
function run(p: TaskPlan, at = 0) {
  updateSessionTaskPlan(p);
  const loop = startItemRun(
    createLoop(p, { now: NOW, sessionTokens: 0 }),
    "1",
    at,
    NOW,
    { sessionTokens: 0 },
  );
  updateSessionLoop(loop);
  return loop;
}

function requests(n: number) {
  for (let i = 0; i < n; i++) services.chatHistory.addAssistantMessage("step");
}

describe("an item's own budget in the CLI, between requests", () => {
  beforeEach(async () => {
    await resetFlowState();
    await registerFlowServices({ llm: new ScriptedLlm([]), mode: "normal" });
    createSession([]);
  });

  afterEach(async () => {
    updateSessionLoop(undefined);
    updateSessionTaskPlan(undefined);
    await resetFlowState();
  });

  it("counts the model requests of the run, not those before it", () => {
    requests(3);
    const loop = run(
      plan({ turns: 10 }),
      services.chatHistory.getHistory().length,
    );
    expect(itemRunTurns(loop)).toBe(0);
    requests(4);
    expect(itemRunTurns(loop)).toBe(4);
  });

  it("ends the run over budget after its tenth request, work kept, and the loop goes on", () => {
    run(plan({ turns: 10 }));
    requests(9);
    expect(endItemRunOverBudget(NOW)).toBe(false);
    requests(1);
    expect(endItemRunOverBudget(NOW)).toBe(true);
    const loop = getSessionLoop()!;
    expect(loop.status).toBe("running");
    expect(loop.current?.overBudget).toEqual({
      which: "turns",
      used: 10,
      limit: 10,
    });
    expect(loop.current?.report?.summary).toContain("Over budget");
    expect(loop.current?.report?.summary).toContain("10 of its 10 turns");
    // A reported run is not ended again
    expect(endItemRunOverBudget(NOW)).toBe(false);
  });

  it("also ends a run over its time budget", () => {
    run(plan({ minutes: 5 }));
    expect(endItemRunOverBudget(new Date(NOW.getTime() + 4 * 60_000))).toBe(
      false,
    );
    expect(endItemRunOverBudget(new Date(NOW.getTime() + 5 * 60_000))).toBe(
      true,
    );
    expect(getSessionLoop()?.current?.overBudget?.which).toBe("minutes");
  });

  it("leaves an item with no budget alone", () => {
    updateSessionTaskPlan(plan({}));
    updateSessionLoop(
      startItemRun(
        createLoop(plan({}), { now: NOW, sessionTokens: 0 }),
        "2",
        0,
        NOW,
        { sessionTokens: 0 },
      ),
    );
    requests(500);
    expect(endItemRunOverBudget(NOW)).toBe(false);
  });

  it("gives the 80% note once per limit, naming the CLI's finish tool", () => {
    run(plan({ turns: 10 }));
    requests(7);
    expect(itemBudgetNoteNow(NOW)).toBeUndefined();
    requests(1);
    const note = itemBudgetNoteNow(NOW);
    expect(note).toContain("80% of its turns");
    expect(note).toContain("8 of 10");
    expect(note).toContain("FinishItem");
    expect(getSessionLoop()?.current?.budgetWarned).toEqual(["turns"]);
    requests(1);
    expect(itemBudgetNoteNow(NOW)).toBeUndefined();
  });

  it("gives no note once the item is over, or when it has no budget", () => {
    run(plan({ turns: 10 }));
    requests(10);
    expect(itemBudgetNoteNow(NOW)).toBeUndefined();
  });
});
