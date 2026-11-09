# Loop budgets and their controls

Status: plan, 2026-11-09. Roadmap row: Track T. Builds on Loop mode (`loop-mode.md`), the usage and cost ledger (Track C, `calculateRequestCost`) and stuck detection (`stuck-detection.md`).

## Why

A loop stops on a budget, so the budget is what the person is really choosing when they start one. Today (`LoopBudget` in `core/index.d.ts`, `DEFAULT_LOOP_BUDGET` in `core/util/loopMode.ts`) the budgets are:

| Budget                   | Field                    | Default    | Where it is editable                          |
| ------------------------ | ------------------------ | ---------- | --------------------------------------------- |
| Rounds (re-plans)        | `maxRounds`              | 5          | Loop controls in the IDE, while the loop runs |
| Tokens (prompt + output) | `maxTokens`              | 10,000,000 | the same                                      |
| Wall time                | `maxWallMs`              | 2 hours    | the same, in minutes                          |
| Attempts per item        | `maxAttempts`            | 2          | not in the UI                                 |
| No-progress rounds       | `maxNoProgressRounds`    | 2          | not in the UI                                 |
| Consecutive failures     | `maxConsecutiveFailures` | 3          | not in the UI                                 |
| Turns per item           | `maxItemTurns`           | 60         | not in the UI                                 |

Gaps:

- **No cost budget.** The question a person asks is "how much may this spend", and tokens are a poor proxy: a million cached input tokens and a million fresh output tokens differ by an order of magnitude in price, and across models by more. The ledger already prices every request (cache reads, writes, regional premium, per model), so a dollar limit is computable.
- **The budgets are fields, not a strategy.** Three autonomy levels (Supervised, Auto, Unattended) each carry a preset, but a person cannot say "stop at five dollars", "ten turns per item", or "one hour, whatever it costs" without editing numbers one at a time, and cannot see how close each is.
- **Counting differs by budget.** Tokens count output plus input the provider did not cache (`loopMode.ts`), rounds count re-plans, turns count model calls. A person cannot tell from the UI which counter will fire first.
- **A limit stops the loop; nothing warns before it.** There is no "80% of the cost budget used" moment to extend or wrap up.

## Design

### Four budget kinds, one control

| Kind       | Unit        | Counts                                                                                           | Stops at                                                                               |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Cost**   | USD         | The ledger's price of each request in the loop, per model (new)                                  | Over the limit; an unpriced model is shown as unknown and cannot be capped (see below) |
| **Turns**  | model calls | Calls across the loop, and per item (`maxItemTurns`)                                             | Per-loop and per-item limits                                                           |
| **Tokens** | tokens      | Output plus input not read from the cache (today's rule), with the cached share shown separately | Over the limit                                                                         |
| **Time**   | minutes     | Wall time of the loop, not counting time waiting for the person (an inbox question, an approval) | Over the limit                                                                         |

A budget set to zero means no limit, as today. A loop may use any combination; the first to be reached stops it, and the reason is named ("Cost budget: $5.02 of $5.00"). Rounds, attempts, no-progress and failures stay as the loop's own safety limits and move under "Safety limits" in the control.

**Unpriced models.** A model with no price in the shared table (a local server, a new model) has no dollar figure. A cost budget then cannot be enforced; the control says so and offers a token or turn budget instead, and the loop never treats the unknown as zero.

### The control

One panel, in the loop controls and in the settings for a loop's defaults:

- A row per kind with a switch, a number and a unit, and a live meter ("$1.84 of $5.00", "212 of 600 turns", "1.2M of 10M tokens", "41 of 120 min"). The meter shows which will fire first.
- A **preset** menu that fills the rows: Frugal, Balanced, Thorough, Unlimited, and the autonomy levels' own, so the existing three levels map onto it. A person can save their own.
- A **per-item** line: turns and, when cost is set, a share of the cost an item may take, so one runaway item cannot use the whole budget.
- **Thresholds**: a warning at 80% (a note in the inbox and the strip), and what happens at the limit: stop, or ask ("The loop has used its cost budget. Add $2, or stop?"), chosen per loop and defaulting to ask when a person is watching and stop when not.
- **Change while running** for every row, as the three editable budgets are today, with the same rule that a change takes effect at the next check.

The CLI gets the same through flags and `cn serve` through the `/state` snapshot and a `loopBudget` message: `--max-cost 5`, `--max-turns 600`, `--max-tokens 10m`, `--max-minutes 120`.

### Where the numbers come from

- **Cost** from the usage ledger: a per-loop running total, summed when each request completes. The ledger's lookup already applies cache reads and writes and the regional premium, so the loop does not price anything itself. The total is an estimate and is labelled so.
- **Turns** from the loop driver's own count (it already counts item turns).
- **Tokens and time** as now.

### Interaction with other tracks

- Stuck detection (Track S) is a different stop: it stops waste inside the budget; the budget stops the whole.
- M3 escalation to a stronger model raises the price per turn; the cost meter makes that visible, and a cost budget bounds it.
- Parallel waves (Track N) spend faster; budgets are shared across workers, and a wave refuses to start when fewer than one item's share remains.

## Build order

| #   | Scope                                                                                                                                                             | Done when                                                                                                                    | State       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- |
| T0  | `maxCostUsd` and a per-loop cost total from the ledger in core; `budgetStop` names the budget and the figures; a priced-model check; tests with a scripted ledger | A loop with a $1 budget stops after the request that crosses it, naming cost; an unpriced model is refused for a cost budget | Not started |
| T1  | The control in the IDE: rows with live meters, the 80% note, stop or ask at the limit, all editable while running                                                 | A person can set and change all four kinds and see which will fire first                                                     | Not started |
| T2  | Presets (Frugal, Balanced, Thorough, Unlimited) mapped to the autonomy levels, savable; per-item limits (turns, cost share)                                       | The three autonomy levels read as presets in the panel with no change in behaviour                                           | Not started |
| T3  | The CLI and `cn serve`: flags, the `/state` snapshot fields, the budget message and the end-of-run report naming the budget that stopped the run                  | A headless run stops on `--max-cost` and the report says so                                                                  | Not started |
| T4  | Wave-aware budgets for parallel workers, and a settings page for the defaults; docs                                                                               | Two workers share one budget; the docs page lists every flag and field                                                       | Not started |

## Decisions for the owner

| #   | Decision                                 | Options and a recommendation                                                                                                                                                         |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Default for a new loop                   | Keep today's numbers (rounds 5, 10M tokens, 2 h) and add a cost budget only when the person sets one (recommended). A default dollar cap would surprise people on cheap local models |
| D2  | At the limit: stop or ask                | Ask when a person is watching, stop when not (recommended)                                                                                                                           |
| D3  | Does waiting on the person count as time | No (recommended): an unanswered question should not use up the time budget                                                                                                           |
