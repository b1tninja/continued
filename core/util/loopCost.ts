import type { LoopCostMark, LoopState, SessionUsage } from "..";
import {
  addCost,
  costOf,
  COST_UNKNOWN_NOTE,
  type CostResult,
  type UserPrice,
} from "./costOf";

/**
 * The loop's cost counter (plans/cost-counter.md). The loop records tokens as
 * one number, which cannot be priced; the session keeps its usage per model
 * and kind. The counter snapshots those totals when a loop or a run starts
 * and prices the difference per model, so no price is looked up here: it is
 * `costOf`, over the same table the chat's cost display uses.
 */

/**
 * The session's per-model totals now, to start or measure a run. No usage yet
 * is an empty mark (nothing used); usage without per-model totals (a session
 * saved before them) cannot be priced, so there is no mark and costs read
 * unknown.
 */
export function costMarkOf(
  usage: SessionUsage | undefined,
): LoopCostMark | undefined {
  if (usage && !usage.byModel) return undefined;
  const mark: LoopCostMark = {};
  for (const [key, m] of Object.entries(usage?.byModel ?? {})) {
    mark[key] = {
      provider: m.provider,
      model: m.model,
      requests: m.requests,
      input: m.inputTokens,
      output: m.outputTokens,
      cacheRead: m.cacheReadTokens,
      cacheWrite: m.cacheWriteTokens,
    };
  }
  return mark;
}

export interface CostSince {
  /** USD of the requests since `from`, or "unknown" */
  amount: number | "unknown";
  /** Models in the slice that have no price */
  unpriced: string[];
  assumptions: string[];
}

/**
 * What was used between two snapshots, priced. A snapshot that is missing
 * (a loop saved before the counter, a host that does not record one) is
 * unknown, not zero. Models with no activity in the slice are skipped, so an
 * unpriced model that was not used does not make the cost unknown.
 */
export function costSince(
  from: LoopCostMark | undefined,
  now: LoopCostMark | undefined,
  options: { userPrices?: Record<string, UserPrice> } = {},
): CostSince {
  if (!from || !now) {
    return { amount: "unknown", unpriced: [], assumptions: [] };
  }
  let amount: number | "unknown" = 0;
  const unpriced: string[] = [];
  const assumptions = new Set<string>();
  for (const [key, cur] of Object.entries(now)) {
    const prev = from[key];
    const d = {
      input: cur.input - (prev?.input ?? 0),
      output: cur.output - (prev?.output ?? 0),
      cacheRead: cur.cacheRead - (prev?.cacheRead ?? 0),
      cacheWrite: cur.cacheWrite - (prev?.cacheWrite ?? 0),
      requests: cur.requests - (prev?.requests ?? 0),
    };
    if (d.requests <= 0 && d.input + d.output + d.cacheRead + d.cacheWrite <= 0)
      continue;
    const result: CostResult = costOf(
      d,
      { provider: cur.provider, model: cur.model },
      { userPrice: options.userPrices?.[key] },
    );
    if (result.amount === "unknown") unpriced.push(key);
    for (const a of result.assumptions) assumptions.add(a);
    amount = addCost(amount, result.amount);
  }
  return { amount, unpriced, assumptions: [...assumptions] };
}

/** The loop's own cost so far, from the session's totals now. */
export function loopCostUsed(
  loop: LoopState,
  sessionMark: LoopCostMark | undefined,
): CostSince {
  return costSince(loop.costAtStart, sessionMark);
}

/**
 * What an item has cost: its earlier runs plus the running run's slice.
 * Undefined when nothing was measured and nothing ran (no cost to show).
 */
export function itemCostNow(
  loop: LoopState,
  itemId: string,
  sessionMark: LoopCostMark | undefined,
): number | "unknown" {
  const item = loop.items.find((i) => i.id === itemId);
  const earlier = item?.usage;
  let total: number | "unknown" =
    earlier?.cost ?? (earlier && earlier.tokens > 0 ? "unknown" : 0);
  const current = loop.current;
  if (current?.kind === "item" && current.itemId === itemId) {
    total = addCost(total, costSince(current.costAtStart, sessionMark).amount);
  }
  return total;
}

/**
 * The line for an item with a dollar budget whose cost is unknown, so the
 * budget is not enforced; undefined when it is enforced or there is no
 * dollar budget.
 */
export function dollarBudgetNote(
  budget: { usd?: number } | undefined,
  cost: number | "unknown" | undefined,
): string | undefined {
  if (budget?.usd === undefined) return undefined;
  return typeof cost === "number" ? undefined : COST_UNKNOWN_NOTE;
}
