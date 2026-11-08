import fs from "fs";
import os from "os";
import path from "path";

import type { ChatHistoryItem, LoopState } from "core/index.js";
import historyManager from "core/util/history.js";
import {
  answerLoop,
  createLoop,
  finishItemRun,
  LOOP_AUTONOMY,
  startItemRun,
} from "core/util/loopMode.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";
import {
  createSession,
  getCurrentSession,
  getSessionLoop,
  getSessionTaskPlan,
  loadOrCreateSessionById,
  updateSessionLoop,
} from "../session.js";
import { savePlan } from "../tools/presentPlan.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import { loopWakeDelay, nextLoopTurn } from "./loopDriver.js";
import { holdLoopCall, loopRepeatGuard } from "./loopHolds.js";
import {
  acceptLoopPlan,
  answerLoopQuestion,
  commitLoop,
  consumeLoopTurnEnd,
  loopPlanBlockForRequest,
  loopRequestHistory,
  requestLoopTurnEnd,
  resetLoopMemory,
  runLoopItemAgain,
  setRunningLoopBudget,
  skipLoopItem,
  startLoopFromPlan,
  withLoopSteering,
} from "./loopSession.js";

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});

/** An assistant message with one finished tool call. */
function toolCallItem(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ChatHistoryItem {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        status: "done",
        parsedArgs: args,
      },
    ],
  };
}

const history = () => services.chatHistory.getHistory();
const append = (...items: ChatHistoryItem[]) =>
  services.chatHistory.setHistory([...history(), ...items]);

/** The loop as it is now, for a change and a commit. */
const loopNow = (): LoopState => getSessionLoop()!;

/** Runs the next turn the driver asks for to a FinishItem report. */
function runItem(outcome: "done" | "stuck" | "waiting" = "done") {
  const turn = nextLoopTurn(history().length);
  expect(turn?.kind).toBe("item");
  append(user(turn!.prompt));
  const loop = loopNow();
  commitLoop({
    ...loop,
    current: loop.current && {
      ...loop.current,
      report: { outcome, summary: `${outcome} it` },
    },
  });
  return turn!;
}

describe("Loop mode's driver in the CLI", () => {
  let cwd: string;

  beforeEach(async () => {
    await resetFlowState();
    updateSessionLoop(undefined);
    resetLoopMemory();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-loop-driver-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await registerFlowServices({ llm: new ScriptedLlm([]), mode: "normal" });
    createSession([]);
    await services.chatHistory.initialize(getCurrentSession(), false);
    append(user("earlier chat"));
  });

  afterEach(async () => {
    updateSessionLoop(undefined);
    resetLoopMemory();
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function planOf(...todos: string[]) {
    await savePlan({ title: "Work", plan: "The work.", todos }, cwd);
  }

  it("re-plans in Plan mode, and a re-plan that adds nothing starts the next round by itself (Auto)", async () => {
    await planOf("One", "Two");
    const loop = startLoopFromPlan("normal")!;
    commitLoop({ ...loop, autonomy: "auto" });

    runItem("done");
    runItem("stuck");
    const replan = nextLoopTurn(history().length);
    expect(replan?.kind).toBe("replan");
    expect(replan?.prompt).toContain('call PresentPlan with the title "Work"');
    expect(services.toolPermissions.getCurrentMode()).toBe("plan");
    // The re-plan's request starts at its own prompt
    append(user(replan!.prompt));
    expect(loopRequestHistory(history())).toEqual([user(replan!.prompt)]);

    // The re-plan presents the same to-dos
    await planOf("One", "Two");
    append(toolCallItem("PresentPlan", {}, "call_plan"));
    const next = nextLoopTurn(history().length);
    expect(next?.kind).toBe("item");
    expect(next?.prompt).toContain("only this item: Two");
    expect(loopNow().round).toBe(2);
    expect(loopNow().replanReason).toBe("The re-plan adds no new to-dos.");
    expect(services.toolPermissions.getCurrentMode()).toBe("normal");
  });

  it("a supervised re-plan waits for Continue the loop", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    expect(loopNow().autonomy).toBe("supervised");
    runItem("stuck");
    expect(nextLoopTurn(history().length)?.kind).toBe("replan");
    await planOf("One", "Two");
    append(toolCallItem("PresentPlan", {}, "call_plan"));

    expect(nextLoopTurn(history().length)).toBeUndefined();
    expect(loopNow().status).toBe("awaiting_plan");
    expect(loopNow().replanReason).toBe(
      "Supervised: every re-plan waits for you.",
    );
    expect(acceptLoopPlan()).toBe(true);
    const next = nextLoopTurn(history().length);
    expect(next?.prompt).toContain("only this item: One");
  });

  it("a re-plan that presents no plan stops the loop", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    runItem("stuck");
    nextLoopTurn(history().length);
    expect(nextLoopTurn(history().length)).toBeUndefined();
    expect(loopNow()).toMatchObject({
      status: "stopped",
      stopReason: "replan_failed",
    });
  });

  it("a loop saved mid-run comes back stopped, its item pending", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    nextLoopTurn(history().length);
    expect(loopNow().current?.kind).toBe("item");
    const { sessionId } = getCurrentSession();
    // What a reload reads: the session file the CLI saved
    const saved = historyManager.load(sessionId);
    expect(saved.loop?.current?.kind).toBe("item");

    loadOrCreateSessionById(sessionId);
    const restored = loopNow();
    expect(restored.status).toBe("stopped");
    expect(restored.current).toBeUndefined();
    expect(restored.items[0].status).toBe("pending");
    expect(restored.stopDetail).toContain("Resume to go on");
    expect(nextLoopTurn(history().length)).toBeUndefined();
  });

  it("delivers a steered answer at the tool boundary, ahead of the person's own steer", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    nextLoopTurn(history().length);
    const held = holdLoopCall({ name: "Write", arguments: { filepath: "a" } });
    expect(held).toMatchObject({ approved: false, denialReason: "loop" });
    const q = loopNow().questions[0];
    expect(answerLoopQuestion({ questionId: q.id, text: "Yes, a" })).toEqual({
      ok: true,
      route: "steer",
      answerId: "a1",
    });

    const boundary = withLoopSteering(async () => user("and hurry"));
    const item = await boundary();
    expect(item?.message.content).toBe(
      `The person answered your question q1 ("${q.question}"): Yes, a\n\nand hurry`,
    );
    // Taken once only
    expect(await withLoopSteering()()).toBeUndefined();

    // It reached the run, so the next run does not carry it again
    const finished = loopNow();
    commitLoop({
      ...finished,
      current: finished.current && {
        ...finished.current,
        report: { outcome: "done" },
      },
    });
    const next = nextLoopTurn(history().length);
    expect(next?.prompt).toContain("only this item: Two");
    expect(loopNow().answers[0].delivered).toBe(true);
  });

  it("a steered answer that misses the run goes with the item's redo", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    nextLoopTurn(history().length);
    answerLoopQuestion({ itemId: "1", text: "Use tabs" });
    // The run ends with done before any tool boundary
    const loop = loopNow();
    commitLoop({
      ...loop,
      current: loop.current && {
        ...loop.current,
        report: { outcome: "done" },
      },
    });
    const redo = nextLoopTurn(history().length);
    expect(redo?.prompt).toContain("Redo it to match their answer below");
    expect(redo?.prompt).toContain("- Use tabs");
  });

  it("refuses the fourth identical call of an item's run, and holds asks in a re-plan", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    nextLoopTurn(history().length);
    const args = { filepath: "a.ts" };
    append(
      toolCallItem("Read", args, "r1"),
      toolCallItem("Read", args, "r2"),
      toolCallItem("Read", args, "r3"),
      toolCallItem("Read", args, "r4"),
    );
    const guard = loopRepeatGuard(["r4"]);
    expect(guard.check({ name: "Read", arguments: args })).toContain(
      "You have made this exact call 4 times",
    );
    expect(guard.check({ name: "Read", arguments: args })).toContain(
      "call FinishItem",
    );
    expect(
      loopRepeatGuard(["r4"]).check({ name: "Read", arguments: { x: 1 } }),
    ).toBeUndefined();

    // The loop's own tools are never held
    expect(holdLoopCall({ name: "FinishItem", arguments: {} })).toEqual({
      approved: true,
    });
    // A grant from Allow once is used up by the call
    const key = { name: "Bash", arguments: { command: "npm test" } };
    holdLoopCall(key);
    const q = loopNow().questions.at(-1)!;
    answerLoopQuestion({ questionId: q.id, text: "", approve: true });
    expect(holdLoopCall(key)).toEqual({ approved: true });
    expect(holdLoopCall(key)).toMatchObject({ approved: false });

    const replan: LoopState = {
      ...loopNow(),
      current: { kind: "replan", historyIndex: 0, startedAt: "" },
    };
    commitLoop(replan);
    expect(holdLoopCall(key)).toMatchObject({
      approved: false,
      denialMessage: expect.stringContaining("with PresentPlan"),
    });
  });

  it("the turn end applies to the main session only", () => {
    // FinishItem asks for it; a subagent's run turns the service off
    requestLoopTurnEnd();
    const ready = services.chatHistory.isReady;
    services.chatHistory.isReady = () => false;
    expect(consumeLoopTurnEnd()).toBe(false);
    services.chatHistory.isReady = ready;
    expect(consumeLoopTurnEnd(true)).toBe(false);
    expect(consumeLoopTurnEnd()).toBe(true);
    expect(consumeLoopTurnEnd()).toBe(false);
  });

  it("sends the plan block with an item's requests, not with a subagent's or compaction's", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    expect(loopPlanBlockForRequest()).toBe("");
    nextLoopTurn(history().length);
    const block = loopPlanBlockForRequest();
    expect(block).toContain("[>] 1. One  <- this item");
    expect(block).toContain("report it with FinishItem");
    expect(loopPlanBlockForRequest(true)).toBe("");
    const ready = services.chatHistory.isReady;
    services.chatHistory.isReady = () => false;
    expect(loopPlanBlockForRequest()).toBe("");
    services.chatHistory.isReady = ready;
  });

  it("an unattended loop wakes when its wait runs out", async () => {
    await planOf("One");
    const plan = getSessionTaskPlan()!;
    const now = new Date("2026-11-07T10:00:00Z");
    let loop = createLoop(plan, {
      now,
      sessionTokens: 0,
      autonomy: "unattended",
    });
    loop = finishItemRun(startItemRun(loop, "1", 0, now), {
      outcome: "waiting",
    });
    expect(loopWakeDelay(loop, now.getTime())).toBeUndefined();
    const waiting = {
      ...loop,
      status: "waiting" as const,
      waitingSince: now.toISOString(),
    };
    expect(loopWakeDelay(waiting, now.getTime() + 60_000)).toBe(
      LOOP_AUTONOMY.unattended.waitTimeoutMs - 60_000,
    );
    expect(
      loopWakeDelay({ ...waiting, autonomy: "auto" }, now.getTime()),
    ).toBeUndefined();
    // answerLoop on a waiting loop resumes it, which the runner then sees
    const resumed = answerLoop(
      { ...waiting, questions: [] },
      { itemId: "1", text: "Go on" },
      now,
    );
    expect(resumed.ok && resumed.loop.status).toBe("running");
  });

  it("skips an item, runs a done one again, and changes the limits", async () => {
    await planOf("One", "Two", "Three");
    startLoopFromPlan("normal");
    expect(skipLoopItem("9")).toEqual({
      ok: false,
      error: "No item 9 in the loop",
    });

    // Item 1 runs; it cannot be skipped while it does
    runItem("done");
    const two = nextLoopTurn(history().length);
    expect(two?.prompt).toContain("only this item: Two");
    expect(skipLoopItem("2").ok).toBe(false);
    expect(runLoopItemAgain("2").ok).toBe(false);

    // Item 3 is skipped meanwhile: the task list shows it cancelled
    expect(skipLoopItem("3").ok).toBe(true);
    expect(getSessionTaskPlan()!.items[2].status).toBe("cancelled");

    // Item 1 again: the next run says it is a repeat at the person's request
    expect(runLoopItemAgain("1").ok).toBe(true);
    expect(getSessionTaskPlan()!.items[0].status).toBe("pending");
    const loop = loopNow();
    commitLoop({
      ...loop,
      current: loop.current && {
        ...loop.current,
        report: { outcome: "done", summary: "Two done" },
      },
    });
    const again = nextLoopTurn(history().length);
    expect(again?.prompt).toContain("only this item: One");
    expect(again?.prompt).toContain("the person asked for it to run again");

    // The limits: out of bounds is refused, and nothing changes
    expect(setRunningLoopBudget({ maxRounds: 51 })).toEqual({
      ok: false,
      error: "maxRounds must be an integer from 1 to 50",
    });
    expect(loopNow().budget.maxRounds).toBe(3);
    expect(
      setRunningLoopBudget({ maxRounds: 1, maxTokens: 0, maxWallMs: 600_000 })
        .ok,
    ).toBe(true);
    expect(loopNow().budget).toMatchObject({
      maxRounds: 1,
      maxTokens: 0,
      maxWallMs: 600_000,
    });

    // Item 1 ends; everything is finished, one of them skipped
    const ran = loopNow();
    commitLoop({
      ...ran,
      current: ran.current && {
        ...ran.current,
        report: { outcome: "done", summary: "One checked" },
      },
    });
    expect(nextLoopTurn(history().length)).toBeUndefined();
    expect(loopNow()).toMatchObject({
      status: "stopped",
      stopReason: "done",
      stopDetail: "All 3 items are done (1 skipped).",
    });
  });
});
