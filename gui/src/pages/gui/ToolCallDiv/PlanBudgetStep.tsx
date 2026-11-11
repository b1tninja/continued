import type { LoopBudget } from "core";
import { formatItemBudget, type ItemBudget } from "core/util/itemBudget";
import type { SplitStrategy } from "core/util/loopBudgetSplit";
import { formatDuration, formatTokenCount } from "core/util/loopUsage";
import {
  budgetAuthority,
  computePlanBudgets,
  DEFAULT_RESERVE,
  NO_PLAN_BUDGET,
  proposeBudgets,
  totalsOf,
  type BudgetAuthority,
  type FinishedUse,
  type PlanBudgetSetup,
} from "core/util/planBudget";
import type { PolicyLevel } from "core/tools/permissions/policy";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50";
const FIELD =
  "w-16 rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground";

const STRATEGIES: Array<[SplitStrategy, string, string]> = [
  ["none", "None", "No budget per to-do except any budget: line in the plan"],
  ["equal", "Equal", "The loop's budget divided by the number of to-dos"],
  [
    "weighted",
    "Weighted",
    "Divided by size: a medium to-do is twice a small one, a large four times",
  ],
  [
    "fair-share",
    "Fair share of what is left",
    "Each to-do may use a third of what remains, or one over the to-dos left if larger; unused budget rolls forward",
  ],
];

const AUTHORITY_TEXT: Record<BudgetAuthority, string> = {
  person:
    "Plan edits is Manual: nothing applies unless you apply it here. The planner's budget lines are shown as proposals.",
  planner:
    "The planner's budget lines stand, within the loop's total, unless you change them here.",
  reviewer:
    "The planner's budget lines stand, within the loop's total; a reviewer may adjust them (not built yet).",
};

export interface PlanBudgetItem {
  text: string;
  /** The planner's `budget:` line */
  budget?: ItemBudget;
}

interface PlanBudgetStepProps {
  items: PlanBudgetItem[];
  level: PolicyLevel;
  /** The loop's budget as it will start */
  loopBudget: Pick<LoopBudget, "maxTokens" | "maxWallMs">;
  /** What finished items of this session's loop used, to propose from */
  history: FinishedUse[];
  value: PlanBudgetSetup;
  onChange: (setup: PlanBudgetSetup) => void;
  onApply: () => void;
  onSkip: () => void;
}

function numberOrUndefined(text: string): number | undefined {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : undefined;
}

/**
 * The budget step of the plan card, before Build in a loop: the loop's
 * budget, a strategy for dividing it, a number beside each to-do (editable in
 * place), and a proposal from finished work. Hidden until asked for; Skip
 * leaves the strategy at None. Core does the arithmetic
 * (core/util/planBudget.ts); this holds the setup and shows the result.
 */
export function PlanBudgetStep({
  items,
  level,
  loopBudget,
  history,
  value,
  onChange,
  onApply,
  onSkip,
}: PlanBudgetStepProps) {
  const ids = items.map((_, i) => String(i + 1));
  const totals = totalsOf(loopBudget);
  const result = computePlanBudgets(
    items.map((item, i) => ({ id: ids[i], budget: item.budget })),
    loopBudget,
    value,
    { plannerBudgets: true },
  );
  const proposal = proposeBudgets(
    ids.map((id) => ({ id, size: value.sizes?.[id] })),
    history,
  );
  const setOverride = (
    id: string,
    kind: "tokens" | "minutes" | "turns",
    text: string,
  ) => {
    const next: ItemBudget = { ...value.overrides?.[id] };
    const n = numberOrUndefined(text);
    if (n === undefined) delete next[kind];
    else next[kind] = n;
    onChange({ ...value, overrides: { ...value.overrides, [id]: next } });
  };
  const authority = budgetAuthority(level);

  return (
    <div
      data-testid="plan-budget"
      className="mt-2 rounded border border-solid border-border px-2 py-1 text-xs"
    >
      <div className="font-medium">Budget</div>
      <div
        data-testid="plan-budget-loop"
        className="text-description"
        title="The loop's own limits; each to-do's share sits inside them"
      >
        The loop:{" "}
        {totals.tokens
          ? `${formatTokenCount(totals.tokens)} tokens`
          : "no token limit"}
        {", "}
        {totals.minutes
          ? formatDuration(totals.minutes * 60_000)
          : "no time limit"}
        .{" "}
        {!totals.tokens && !totals.minutes
          ? "With no limit there is nothing to divide; budget lines and your own numbers still apply."
          : ""}
      </div>
      <div data-testid="plan-budget-authority" className="text-description">
        {AUTHORITY_TEXT[authority]}
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <label className="flex shrink-0 items-center gap-0.5 py-1">
          Divide
          <select
            data-testid="plan-budget-strategy"
            value={value.strategy}
            title={STRATEGIES.find(([s]) => s === value.strategy)?.[2]}
            onChange={(e) =>
              onChange({
                ...value,
                strategy: e.target.value as SplitStrategy,
                reserve:
                  e.target.value !== "none" && value.reserve === 0
                    ? DEFAULT_RESERVE
                    : value.reserve,
              })
            }
            className="cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
          >
            {STRATEGIES.map(([strategy, label]) => (
              <option key={strategy} value={strategy}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex shrink-0 items-center gap-0.5 py-1"
          title="Held back for extensions, re-plans and a final check"
        >
          Reserve %
          <input
            type="number"
            data-testid="plan-budget-reserve"
            min={0}
            max={90}
            value={Math.round(value.reserve * 100)}
            onChange={(e) =>
              onChange({
                ...value,
                reserve: Math.min(
                  0.9,
                  Math.max(0, Number(e.target.value) / 100),
                ),
              })
            }
            className={FIELD}
          />
        </label>
        <button
          type="button"
          data-testid="plan-budget-propose"
          className={BUTTON}
          disabled={!proposal.budgets}
          title={proposal.note}
          onClick={() => {
            const overrides: Record<string, ItemBudget> = {};
            for (const id of ids) {
              overrides[id] = {
                ...value.overrides?.[id],
                ...proposal.budgets?.[id],
              };
            }
            onChange({ ...value, overrides });
          }}
        >
          Use the proposal
        </button>
      </div>
      <div data-testid="plan-budget-proposal" className="text-description">
        {proposal.note}
      </div>
      {result.reserve.tokens || result.reserve.minutes ? (
        <div
          data-testid="plan-budget-reserve-held"
          className="text-description"
        >
          Held back:{" "}
          {[
            result.reserve.tokens
              ? `${formatTokenCount(result.reserve.tokens)} tokens`
              : "",
            result.reserve.minutes
              ? formatDuration(result.reserve.minutes * 60_000)
              : "",
          ]
            .filter(Boolean)
            .join(", ")}
        </div>
      ) : null}
      <ul className="m-0 mt-1 list-none p-0">
        {items.map((item, i) => {
          const id = ids[i];
          const got = result.budgets[id] ?? {};
          const capped = result.capped[id];
          return (
            <li
              key={id}
              data-testid={`plan-budget-item-${id}`}
              className="py-0.5"
            >
              <div className="break-words text-foreground" title={item.text}>
                {id}. {item.text}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-description">
                {value.strategy === "weighted" && (
                  <select
                    data-testid={`plan-budget-size-${id}`}
                    value={value.sizes?.[id] ?? "S"}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        sizes: { ...value.sizes, [id]: e.target.value },
                      })
                    }
                    className="rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
                  >
                    <option value="S">S</option>
                    <option value="M">M</option>
                    <option value="L">L</option>
                  </select>
                )}
                {(
                  [
                    ["tokens", "tokens"],
                    ["minutes", "min"],
                    ["turns", "turns"],
                  ] as const
                ).map(([kind, unit]) => (
                  <label key={kind} className="flex items-center gap-0.5 py-1">
                    <input
                      type="number"
                      min={0}
                      data-testid={`plan-budget-${kind}-${id}`}
                      aria-label={`${unit} for to-do ${id}`}
                      placeholder="none"
                      value={got[kind] ?? ""}
                      onChange={(e) => setOverride(id, kind, e.target.value)}
                      className={FIELD}
                    />
                    {unit}
                  </label>
                ))}
                {item.budget && (
                  <span
                    className="text-description"
                    title="The planner's budget line"
                  >
                    planner: {formatItemBudget(item.budget)}
                  </span>
                )}
                {capped && (
                  <span
                    data-testid={`plan-budget-capped-${id}`}
                    className="text-warning"
                  >
                    capped at what the loop has left ({capped.join(", ")})
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="plan-budget-apply"
          className={BUTTON}
          title="Use these budgets when the loop starts"
          onClick={onApply}
        >
          Apply
        </button>
        <button
          type="button"
          data-testid="plan-budget-skip"
          className={BUTTON}
          title="No budget per to-do: the strategy stays None"
          onClick={() => {
            onChange(NO_PLAN_BUDGET);
            onSkip();
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
