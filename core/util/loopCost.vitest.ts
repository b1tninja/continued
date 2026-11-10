import { describe, expect, it } from "vitest";
import type { ModelUsage, SessionUsage } from "..";
import { itemBudgetStatus, itemBudgetStatusOf } from "./itemBudget";
import {
  costMarkOf,
  costSince,
  dollarBudgetNote,
  itemCostNow,
  loopCostUsed,
} from "./loopCost";
import { createLoop, finishItemRun, startItemRun } from "./loopMode";
import { loopUsage } from "./loopUsage";

const T0 = new Date("2026-11-10T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const plan = {
  items: [
    { id: "1", text: "A", status: "pending" as const, budget: { usd: 1 } },
    { id: "2", text: "B", status: "pending" as const },
  ],
  updatedAt: T0.toISOString(),
};

function model(
  provider: string,
  name: string,
  m: Partial<ModelUsage>,
): [string, ModelUsage] {
  return [
    `${provider}/${name}`,
    {
      provider,
      model: name,
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      pricedRequests: 0,
      ...m,
    },
  ];
}

function session(...rows: Array<[string, ModelUsage]>): SessionUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
    byModel: Object.fromEntries(rows),
  };
}

// Sonnet 4.6: $3 / $15 per MTok
const sonnet = (inputTokens: number, outputTokens: number) =>
  model("anthropic", "claude-sonnet-4-6", {
    inputTokens,
    outputTokens,
    requests: 1,
  });
const local = (inputTokens: number) =>
  model("ollama", "llama3", { inputTokens, requests: 1 });

describe("costMarkOf and costSince", () => {
  it("prices only what was used between two marks", () => {
    const from = costMarkOf(session(sonnet(1_000_000, 0)));
    const now = costMarkOf(session(sonnet(2_000_000, 1_000_000)));
    expect(costSince(from, now).amount).toBeCloseTo(3 + 15, 6);
  });

  it("is zero for no use and for no session yet", () => {
    expect(costSince(costMarkOf(undefined), costMarkOf(undefined)).amount).toBe(
      0,
    );
    const mark = costMarkOf(session(sonnet(10, 10)));
    expect(costSince(mark, mark).amount).toBe(0);
  });

  it("sums models and is unknown when a used model has no price", () => {
    const from = costMarkOf(session(sonnet(0, 0)));
    const now = costMarkOf(session(sonnet(1_000_000, 0), local(5_000)));
    const r = costSince(from, now);
    expect(r.amount).toBe("unknown");
    expect(r.unpriced).toEqual(["ollama/llama3"]);
  });

  it("does not let an unpriced model that was not used spoil the cost", () => {
    const from = costMarkOf(session(sonnet(0, 0), local(5_000)));
    const now = costMarkOf(session(sonnet(1_000_000, 0), local(5_000)));
    expect(costSince(from, now).amount).toBeCloseTo(3, 6);
  });

  it("is unknown without a mark, never zero", () => {
    expect(costSince(undefined, {}).amount).toBe("unknown");
    expect(costSince({}, undefined).amount).toBe("unknown");
    // Usage saved without per-model totals cannot be priced
    expect(
      costMarkOf({ promptTokens: 5, completionTokens: 5, totalCost: 1 }),
    ).toBeUndefined();
  });

  it("uses a price the person entered for a local model", () => {
    const from = costMarkOf(session(local(0)));
    const now = costMarkOf(session(local(2_000_000)));
    const r = costSince(from, now, {
      userPrices: { "ollama/llama3": { input: 0, output: 0 } },
    });
    expect(r.amount).toBe(0);
  });
});

describe("the loop's and the item's counters", () => {
  it("counts the loop's own use, not what the session had before it", () => {
    const before = costMarkOf(session(sonnet(10_000_000, 0)));
    const loop = createLoop(plan, {
      now: T0,
      sessionTokens: 0,
      costMark: before,
    });
    const now = costMarkOf(session(sonnet(11_000_000, 0)));
    expect(loopCostUsed(loop, now).amount).toBeCloseTo(3, 6);
    const u = loopUsage(loop, {
      sessionTokens: 0,
      now: minutes(1),
      costMark: now,
    });
    expect(u.cost).toBeCloseTo(3, 6);
  });

  it("is unknown for a loop started without a mark", () => {
    const loop = createLoop(plan, { now: T0, sessionTokens: 0 });
    expect(loopCostUsed(loop, {}).amount).toBe("unknown");
  });

  it("records each run's cost on the item and adds a second run's", () => {
    let loop = createLoop(plan, { now: T0, sessionTokens: 0, costMark: {} });
    loop = startItemRun(loop, "1", 0, T0, {
      sessionTokens: 0,
      costMark: costMarkOf(session(sonnet(0, 0))),
    });
    loop = finishItemRun(
      loop,
      { outcome: "later" },
      {
        sessionTokens: 1_000_000,
        now: minutes(2),
        costMark: costMarkOf(session(sonnet(1_000_000, 0))),
      },
    );
    expect(loop.items[0].usage?.cost).toBeCloseTo(3, 6);
    loop = startItemRun(loop, "1", 0, minutes(5), {
      sessionTokens: 1_000_000,
      costMark: costMarkOf(session(sonnet(1_000_000, 0))),
    });
    loop = finishItemRun(
      loop,
      { outcome: "done" },
      {
        sessionTokens: 1_000_000,
        now: minutes(6),
        costMark: costMarkOf(session(sonnet(1_000_000, 100_000))),
      },
    );
    expect(loop.items[0].usage?.cost).toBeCloseTo(3 + 1.5, 6);
  });

  it("makes the item's cost unknown after a run that used an unpriced model", () => {
    let loop = createLoop(plan, { now: T0, sessionTokens: 0, costMark: {} });
    loop = startItemRun(loop, "1", 0, T0, { sessionTokens: 0, costMark: {} });
    loop = finishItemRun(
      loop,
      { outcome: "later" },
      {
        sessionTokens: 5_000,
        now: minutes(1),
        costMark: costMarkOf(session(local(5_000))),
      },
    );
    expect(loop.items[0].usage?.cost).toBe("unknown");
    // and it stays unknown: a later priced run cannot repair the total
    loop = startItemRun(loop, "1", 0, minutes(2), {
      sessionTokens: 5_000,
      costMark: costMarkOf(session(local(5_000))),
    });
    loop = finishItemRun(
      loop,
      { outcome: "done" },
      {
        sessionTokens: 5_000,
        now: minutes(3),
        costMark: costMarkOf(session(local(5_000), sonnet(1_000_000, 0))),
      },
    );
    expect(loop.items[0].usage?.cost).toBe("unknown");
  });

  it("includes the running run in the item's cost now", () => {
    let loop = createLoop(plan, { now: T0, sessionTokens: 0, costMark: {} });
    loop = startItemRun(loop, "1", 0, T0, {
      sessionTokens: 0,
      costMark: costMarkOf(session(sonnet(0, 0))),
    });
    const mark = costMarkOf(session(sonnet(500_000, 0)));
    expect(itemCostNow(loop, "1", mark)).toBeCloseTo(1.5, 6);
    expect(itemCostNow(loop, "2", mark)).toBe(0);
  });
});

describe("a dollar budget", () => {
  const budget = { usd: 1 };
  const use = (usd?: number | "unknown") => ({
    turns: 1,
    tokens: 1,
    ms: 1,
    ...(usd !== undefined ? { usd } : {}),
  });

  it("stops over_budget once the known cost reaches it", () => {
    expect(itemBudgetStatusOf(budget, use(0.5))).toEqual({ state: "ok" });
    expect(itemBudgetStatusOf(budget, use(0.8))).toMatchObject({
      state: "warn80",
      which: "usd",
    });
    expect(itemBudgetStatusOf(budget, use(1.02))).toMatchObject({
      state: "over",
      which: "usd",
      used: 1.02,
      limit: 1,
    });
  });

  it("is not enforced while the cost is unknown or not measured", () => {
    expect(itemBudgetStatusOf(budget, use("unknown"))).toEqual({ state: "ok" });
    expect(itemBudgetStatusOf(budget, use())).toEqual({ state: "ok" });
  });

  it("says why it is not enforced, only then", () => {
    expect(dollarBudgetNote(budget, "unknown")).toBe(
      "cost unknown for this model; dollar budget not enforced",
    );
    expect(dollarBudgetNote(budget, undefined)).toContain("not enforced");
    expect(dollarBudgetNote(budget, 0.2)).toBeUndefined();
    expect(dollarBudgetNote({}, "unknown")).toBeUndefined();
    expect(dollarBudgetNote(undefined, "unknown")).toBeUndefined();
  });

  it("goes through the loop's item path: priced model over budget, unpriced one not", () => {
    const start = (m: SessionUsage) => {
      let loop = createLoop(plan, { now: T0, sessionTokens: 0, costMark: {} });
      loop = startItemRun(loop, "1", 0, T0, {
        sessionTokens: 0,
        costMark: costMarkOf(m),
      });
      return loop;
    };
    const item = plan.items[0];
    const ctx = { sessionTokens: 0, now: minutes(1), turns: 1 };

    const priced = start(session(sonnet(0, 0)));
    // 400K output tokens on Sonnet 4.6 is $6
    const over = itemBudgetStatus(priced, item, {
      ...ctx,
      costMark: costMarkOf(session(sonnet(0, 400_000))),
    });
    expect(over).toMatchObject({ state: "over", which: "usd" });

    const unpriced = start(session(local(0)));
    const free = itemBudgetStatus(unpriced, item, {
      ...ctx,
      costMark: costMarkOf(session(local(50_000_000))),
    });
    expect(free).toEqual({ state: "ok" });
  });
});
