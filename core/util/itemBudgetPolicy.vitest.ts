import { describe, expect, it } from "vitest";
import type { LoopAutonomy, LoopState } from "../index.js";
import { overBudgetReport } from "./itemBudget";
import {
  answerLimitQuestion,
  applyLimitPolicy,
  defaultLimitPolicy,
  extendItem,
  isProgressing,
  limitPolicyOf,
  planExtension,
  type LimitPolicy,
} from "./itemBudgetPolicy";
import {
  createLoop,
  finishItemRun,
  loopReplanPrompt,
  startItemRun,
} from "./loopMode";
import { buildTaskPlan } from "./taskPlan";

const T0 = new Date("2026-11-09T10:00:00Z");
const built = buildTaskPlan([{ text: "first" }, { text: "second" }], {});
if (!built.ok) throw new Error(built.error);
const plan = built.plan;
const breach = { which: "tokens" as const, used: 11_000, limit: 10_000 };
const item = { id: "1", budget: { tokens: 10_000 } };

/** A loop whose item 1 just ended over its token budget. */
function stuckItem(
  options: {
    policy?: LimitPolicy;
    autonomy?: LoopAutonomy;
    reserve?: LoopState["reserve"];
  } = {},
): LoopState {
  let loop = createLoop(plan, {
    now: T0,
    sessionTokens: 0,
    autonomy: options.autonomy ?? "auto",
  });
  if (options.policy) loop = { ...loop, limitPolicy: options.policy };
  if (options.reserve) loop = { ...loop, reserve: options.reserve };
  loop = startItemRun(loop, "1", 0, T0, { sessionTokens: 0 });
  loop = {
    ...loop,
    current: {
      ...loop.current!,
      overBudget: breach,
      report: overBudgetReport(breach),
    },
  };
  return finishItemRun(loop, loop.current!.report, {
    sessionTokens: 11_000,
    now: new Date(T0.getTime() + 60_000),
  });
}

describe("limit policy defaults", () => {
  it.each([
    ["supervised", "suggest"],
    ["auto", "review"],
    ["unattended", "force"],
    ["idgaf", "force"],
  ] as const)("%s reads as %s", (autonomy, policy) => {
    expect(defaultLimitPolicy(autonomy)).toBe(policy);
  });

  it("the loop's own setting wins over its level's", () => {
    const loop = { ...stuckItem(), limitPolicy: "suggest" as const };
    expect(limitPolicyOf(loop)).toBe("suggest");
    expect(limitPolicyOf(stuckItem({ autonomy: "unattended" }))).toBe("force");
  });
});

describe("planExtension and extendItem", () => {
  it("draws tokens from the reserve, and never past it", () => {
    const loop = stuckItem({ reserve: { tokens: 3_000 } });
    // Half the limit would be 5,000: the reserve has 3,000
    expect(planExtension(loop, item, breach)).toEqual({
      ok: true,
      which: "tokens",
      amount: 3_000,
    });
    const done = extendItem(loop, item, breach);
    expect(done).toMatchObject({ ok: true, amount: 3_000 });
    if (!done.ok) return;
    expect(done.budget.tokens).toBe(13_000);
    expect(done.loop.reserve?.tokens).toBe(0);
    const state = done.loop.items.find((i) => i.id === "1")!;
    expect(state).toMatchObject({
      status: "pending",
      attempts: 0,
      extensions: 1,
    });
    expect(state.overBudget).toBeUndefined();
    // The reserve is spent: a second extension cannot exceed it
    const again = extendItem(
      done.loop,
      { id: "1", budget: done.budget },
      breach,
    );
    expect(again.ok).toBe(false);
  });

  it("with no reserve there is no extension of tokens or minutes", () => {
    const loop = stuckItem();
    expect(planExtension(loop, item, breach)).toMatchObject({ ok: false });
    expect(
      planExtension(
        loop,
        { id: "1", budget: { minutes: 10 } },
        { which: "minutes", used: 11, limit: 10 },
      ),
    ).toMatchObject({ ok: false });
  });

  it("extends turns by half the limit, once, with no reserve to spend", () => {
    const loop = stuckItem();
    const turns = { which: "turns" as const, used: 10, limit: 10 };
    const first = extendItem(loop, { id: "1", budget: { turns: 10 } }, turns);
    expect(first).toMatchObject({ ok: true, amount: 5 });
    if (!first.ok) return;
    expect(first.budget.turns).toBe(15);
    const second = extendItem(
      first.loop,
      { id: "1", budget: first.budget },
      turns,
    );
    expect(second.ok).toBe(false);
  });
});

describe("isProgressing", () => {
  it("needs evidence, and a stuck signal cancels it", () => {
    expect(isProgressing(undefined)).toBe(false);
    expect(isProgressing({ changedFiles: 0 })).toBe(false);
    expect(isProgressing({ changedFiles: 2 })).toBe(true);
    expect(isProgressing({ changedFiles: 0, checkImproved: true })).toBe(true);
    expect(isProgressing({ changedFiles: 2, stuckLevel: "stuck" })).toBe(false);
    expect(isProgressing({ changedFiles: 2, stuckLevel: "note" })).toBe(true);
  });
});

describe("applyLimitPolicy", () => {
  it("does nothing for an item that did not run over", () => {
    const loop = createLoop(plan, { now: T0, sessionTokens: 0 });
    expect(applyLimitPolicy(loop, item, { now: T0 })).toBeUndefined();
  });

  it("Force stops: the item stays failed and the loop's strategy runs", () => {
    const loop = stuckItem({ policy: "force", reserve: { tokens: 50_000 } });
    const decision = applyLimitPolicy(loop, item, { now: T0 })!;
    expect(decision.kind).toBe("stop");
    expect(decision.loop.items[0].status).toBe("failed");
    expect(decision.loop.reserve).toEqual({ tokens: 50_000 });
  });

  it("Suggest holds a question with the four choices and waits on it", () => {
    const loop = stuckItem({ policy: "suggest", reserve: { tokens: 50_000 } });
    const decision = applyLimitPolicy(loop, item, { now: T0 })!;
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") return;
    expect(decision.question.options).toEqual([
      "Extend",
      "Split",
      "Skip",
      "Block",
    ]);
    expect(decision.question.question).toContain(
      "5,000 tokens from the reserve",
    );
    expect(decision.loop.items[0].status).toBe("waiting");
    // Asked once: a second call returns the same question
    const again = applyLimitPolicy(decision.loop, item, { now: T0 })!;
    expect(again.kind === "ask" && again.question.id).toBe(
      decision.question.id,
    );
    expect(again.loop.questions).toHaveLength(1);
  });

  it("Suggest without a reserve does not offer Extend", () => {
    const decision = applyLimitPolicy(stuckItem({ policy: "suggest" }), item, {
      now: T0,
    })!;
    expect(decision.kind === "ask" && decision.question.options).toEqual([
      "Split",
      "Skip",
      "Block",
    ]);
  });

  it("Review extends a progressing item once, within half the reserve", () => {
    const loop = stuckItem({ policy: "review", reserve: { tokens: 6_000 } });
    const decision = applyLimitPolicy(loop, item, {
      now: T0,
      progress: { changedFiles: 3 },
    })!;
    expect(decision).toMatchObject({ kind: "extend", amount: 3_000 });
    if (decision.kind !== "extend") return;
    expect(decision.budget.tokens).toBe(13_000);
    expect(decision.loop.reserve?.tokens).toBe(3_000);
    // Run over again: the second extension is refused, so the review splits
    const again = {
      ...decision.loop,
      items: decision.loop.items.map((i) => ({ ...i, overBudget: breach })),
    };
    const second = applyLimitPolicy(
      again,
      { id: "1", budget: decision.budget },
      { now: T0, progress: { changedFiles: 3 } },
    )!;
    expect(second.kind).toBe("split");
    expect(second.loop.replanRequested).toBe(true);
  });

  it("Review stops an item with no progress, or a stuck one", () => {
    const loop = stuckItem({ policy: "review", reserve: { tokens: 60_000 } });
    expect(applyLimitPolicy(loop, item, { now: T0 })!.kind).toBe("stop");
    expect(
      applyLimitPolicy(loop, item, {
        now: T0,
        progress: { changedFiles: 4, stuckLevel: "stuck" },
      })!.kind,
    ).toBe("stop");
  });

  it("Review takes a plugged-in reviewer's verdict, but cannot exceed the reserve", () => {
    const loop = stuckItem({ policy: "review", reserve: { tokens: 1_000 } });
    const decision = applyLimitPolicy(loop, item, {
      now: T0,
      review: () => "extend",
    })!;
    // Half of 1,000 is the most a review may take
    expect(decision).toMatchObject({ kind: "extend", amount: 500 });
    const none = applyLimitPolicy(stuckItem({ policy: "review" }), item, {
      now: T0,
      review: () => "extend",
    })!;
    expect(none.kind).toBe("stop");
  });
});

describe("answerLimitQuestion", () => {
  const asked = () => {
    const loop = stuckItem({ policy: "suggest", reserve: { tokens: 50_000 } });
    const decision = applyLimitPolicy(loop, item, { now: T0 })!;
    if (decision.kind !== "ask") throw new Error("not asked");
    return { loop: decision.loop, id: decision.question.id };
  };

  it("Extend raises the limit from the reserve and runs the item again", () => {
    const { loop, id } = asked();
    const result = answerLimitQuestion(loop, item, id, "Extend", T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budget?.tokens).toBe(15_000);
    expect(result.loop.reserve?.tokens).toBe(45_000);
    expect(result.loop.items[0].status).toBe("pending");
    expect(result.loop.questions[0].answerId).toBe(result.answer.id);
    expect(result.loop.status).toBe("running");
  });

  it("Split asks for a re-plan that sees the item's findings", () => {
    const { loop, id } = asked();
    const result = answerLimitQuestion(loop, item, id, "split", T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loop.replanRequested).toBe(true);
    expect(result.loop.items[0].status).toBe("failed");
    const prompt = loopReplanPrompt({ loop: result.loop, plan });
    expect(prompt).toContain("over budget");
    expect(prompt).toContain("11,000 of its 10,000 tokens");
  });

  it("Skip skips the item, Block leaves it failed", () => {
    const skip = asked();
    const skipped = answerLimitQuestion(skip.loop, item, skip.id, "Skip", T0);
    expect(skipped.ok && skipped.loop.items[0]).toMatchObject({
      status: "done",
      skipped: true,
    });
    const block = asked();
    const blocked = answerLimitQuestion(
      block.loop,
      item,
      block.id,
      "Block",
      T0,
    );
    expect(blocked.ok && blocked.loop.items[0].status).toBe("failed");
    expect(blocked.ok && blocked.loop.replanRequested).toBeFalsy();
  });

  it("refuses a written answer, a second answer and a foreign question", () => {
    const { loop, id } = asked();
    expect(answerLimitQuestion(loop, item, id, "do more", T0).ok).toBe(false);
    const done = answerLimitQuestion(loop, item, id, "Block", T0);
    if (!done.ok) throw new Error("expected ok");
    expect(answerLimitQuestion(done.loop, item, id, "Skip", T0).ok).toBe(false);
    expect(answerLimitQuestion(loop, item, "q99", "Skip", T0).ok).toBe(false);
  });

  it("Extend is refused once the reserve is gone, and nothing changes", () => {
    const { loop, id } = asked();
    const spent = { ...loop, reserve: { tokens: 0 } };
    const result = answerLimitQuestion(spent, item, id, "Extend", T0);
    expect(result.ok).toBe(false);
    expect(spent.questions[0].answerId).toBeUndefined();
  });
});
