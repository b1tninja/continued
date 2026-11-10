import type { LoopBudget, TaskPlan } from "..";
import type { PolicyLevel } from "../tools/permissions/policy";
import {
  parseItemBudget,
  type BudgetKind,
  type ItemBudget,
} from "./itemBudget";
import {
  sizeWeight,
  splitBudget,
  type SplitStrategy,
  type SplitTotals,
} from "./loopBudgetSplit";

/**
 * The budget step of the plan card (plans/loop-budgets.md, "Entering the
 * loop"): the loop's budget divided among the plan's to-dos by a strategy,
 * a number beside each, a proposal from finished work. Pure: the card holds
 * the setup, calls these, and writes the result into the task list.
 */
export interface PlanBudgetSetup {
  strategy: SplitStrategy;
  /** Share of the loop's budget held back for extensions, 0 to 0.9 */
  reserve: number;
  /** S, M or L per item id, for the weighted strategy */
  sizes?: Record<string, string>;
  /** The person's own numbers per item id: they win over everything else */
  overrides?: Record<string, ItemBudget>;
}

/** What the card starts with, and what Skip leaves: no division. */
export const NO_PLAN_BUDGET: PlanBudgetSetup = { strategy: "none", reserve: 0 };

export const DEFAULT_RESERVE = 0.2;

/**
 * Who sets the budgets, from the Plan edits level (plans/policy-areas.md):
 * - person: Manual. The planner's `budget:` lines are proposals; nothing
 *   applies unless the person applies the step.
 * - planner: Cautious and Permissive and above. The planner's budgets
 *   stand, within the loop's total, and the person may change any.
 * - reviewer: Automatic. As planner; a reviewer may adjust them (not built:
 *   the planner's stand).
 */
export type BudgetAuthority = "person" | "planner" | "reviewer";

export function budgetAuthority(level: PolicyLevel): BudgetAuthority {
  switch (level) {
    case "manual":
      return "person";
    case "automatic":
      return "reviewer";
    default:
      return "planner";
  }
}

/** Whether the planner's own `budget:` lines apply without the person's say. */
export function plannerBudgetsApply(level: PolicyLevel): boolean {
  return budgetAuthority(level) !== "person";
}

export interface BudgetItem {
  id: string;
  /** The planner's `budget:` line */
  budget?: ItemBudget;
}

export interface PlanBudgets {
  /** What each item may use, turns and dollars carried through */
  budgets: Record<string, ItemBudget>;
  /** Held back for extensions, re-plans and a final check */
  reserve: SplitTotals;
  /** Kinds an item asked for more of than the loop has left, capped to it */
  capped: Record<string, BudgetKind[]>;
  /** The totals that were divided; empty when the loop's budget has no limit */
  totals: SplitTotals;
}

/** The loop's token and minute limits as the totals to divide (0: none). */
export function totalsOf(
  budget: Pick<LoopBudget, "maxTokens" | "maxWallMs">,
): SplitTotals {
  return {
    ...(budget.maxTokens > 0 ? { tokens: budget.maxTokens } : {}),
    ...(budget.maxWallMs > 0
      ? { minutes: Math.floor(budget.maxWallMs / 60_000) }
      : {}),
  };
}

/**
 * The budget of every item under the setup. Precedence, as in the plan: the
 * person's numbers, then the planner's line (when it applies), then the
 * strategy's share. An item's number is capped at what the loop has left.
 */
export function computePlanBudgets(
  items: BudgetItem[],
  loopBudget: Pick<LoopBudget, "maxTokens" | "maxWallMs">,
  setup: PlanBudgetSetup,
  options: { plannerBudgets: boolean },
): PlanBudgets {
  const totals = totalsOf(loopBudget);
  const asked: Record<string, ItemBudget> = {};
  for (const item of items) {
    asked[item.id] = {
      ...(options.plannerBudgets ? item.budget : undefined),
      ...setup.overrides?.[item.id],
    };
  }
  const split = splitBudget(
    totals,
    items.map((item) => ({
      id: item.id,
      weight: sizeWeight(setup.sizes?.[item.id]),
      budget: asked[item.id],
    })),
    { strategy: setup.strategy, reserve: setup.reserve },
  );
  const budgets: Record<string, ItemBudget> = {};
  const capped: Record<string, BudgetKind[]> = {};
  for (const item of items) {
    const got = split.budgets[item.id];
    const want = asked[item.id];
    // Turns and dollars are not divided: the item's own number stands
    budgets[item.id] = {
      ...got,
      ...(want.turns !== undefined ? { turns: want.turns } : {}),
      ...(want.usd !== undefined ? { usd: want.usd } : {}),
    };
    for (const kind of ["tokens", "minutes"] as const) {
      if (
        want[kind] !== undefined &&
        got[kind] !== undefined &&
        got[kind] < want[kind]
      ) {
        (capped[item.id] ??= []).push(kind);
      }
    }
  }
  return { budgets, reserve: split.reserve, capped, totals };
}

/** The plan's items with the budgets written in; an empty budget is removed. */
export function applyPlanBudgets(
  plan: TaskPlan,
  budgets: Record<string, ItemBudget>,
): TaskPlan {
  return {
    ...plan,
    items: plan.items.map((item) => {
      const { budget: _old, ...rest } = item;
      const b = budgets[item.id];
      return b && Object.keys(b).length > 0 ? { ...rest, budget: b } : rest;
    }),
  };
}

/** A finished item's use, from `LoopItemState.usage`. */
export interface FinishedUse {
  tokens: number;
  ms: number;
}

/** Headroom over the median, so a typical item does not end at its limit. */
export const PROPOSAL_HEADROOM = 2;

export interface BudgetProposal {
  /** Per item id; absent when there is no history to propose from */
  budgets?: Record<string, ItemBudget>;
  /** One line for the card */
  note: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A budget for each item from what finished items used: the median tokens
 * and minutes times PROPOSAL_HEADROOM, scaled by the item's size against a
 * medium one (no size line: medium). Without finished items it says so and
 * proposes nothing, rather than guessing.
 */
export function proposeBudgets(
  items: Array<{ id: string; size?: string }>,
  history: FinishedUse[],
): BudgetProposal {
  const used = history.filter((h) => h.tokens > 0 || h.ms > 0);
  if (used.length === 0) {
    return {
      note: "No history: no finished item to estimate from, so nothing is proposed.",
    };
  }
  const tokens = median(used.map((h) => h.tokens));
  const minutes = median(used.map((h) => h.ms / 60_000));
  const medium = sizeWeight("M");
  const budgets: Record<string, ItemBudget> = {};
  for (const item of items) {
    const scale = (sizeWeight(item.size ?? "M") / medium) * PROPOSAL_HEADROOM;
    budgets[item.id] = {
      ...(tokens > 0
        ? { tokens: Math.max(1, Math.round(tokens * scale)) }
        : {}),
      ...(minutes > 0
        ? { minutes: Math.max(1, Math.round(minutes * scale)) }
        : {}),
    };
  }
  return {
    budgets,
    note: `From ${used.length} finished item${used.length === 1 ? "" : "s"} in this loop: the median, ${PROPOSAL_HEADROOM} times over, scaled by size.`,
  };
}

/** A plan item's `budget` as the plan carries it (a line or an object), or none. */
export function budgetFromInput(raw: unknown): ItemBudget | undefined {
  if (typeof raw === "string") {
    const parsed = parseItemBudget(raw);
    return parsed.ok ? parsed.budget : undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const budget: ItemBudget = {};
    for (const kind of ["turns", "tokens", "minutes", "usd"] as const) {
      const v = o[kind];
      if (typeof v === "number" && v > 0) budget[kind] = v;
    }
    return Object.keys(budget).length > 0 ? budget : undefined;
  }
  return undefined;
}

/**
 * The card keys its setup by position ("1" is the first to-do), because the
 * to-dos have no ids until the loop reads the plan; this re-keys it by the
 * ids the task list gave them.
 */
export function setupByItemId(
  setup: PlanBudgetSetup,
  ids: string[],
): PlanBudgetSetup {
  const rekey = <T>(map: Record<string, T> | undefined) =>
    map
      ? Object.fromEntries(
          Object.entries(map).flatMap(([position, value]) => {
            const id = ids[Number(position) - 1];
            return id ? [[id, value] as const] : [];
          }),
        )
      : undefined;
  return {
    ...setup,
    sizes: rekey(setup.sizes),
    overrides: rekey(setup.overrides),
  };
}
