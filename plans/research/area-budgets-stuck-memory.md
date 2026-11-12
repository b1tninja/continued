# Area research: loop budgets (Track T), stuck detection (Track S), memory and session history (Track V)

Date: 2026-11-12. Research only: no product code and no change to `plans/ROADMAP.md`. Read against `origin/main` at `028a74050` (after #674). Fork: b1tninja/continuous. Scheduled for the release after 2.15.0 (2.16.0 here); 2.15.0 is not touched.

Not repeated here, referenced: `plans/loop-budgets.md`, `plans/stuck-detection.md`, `plans/stuck-calibration.md`, `plans/memory-and-history.md`, `plans/memory-ageing.md`, `research/benchmarks-toolcalls-loops.md` (sections 5.3 to 5.5), `research/interop-memory-ux-release.md` (section 3), `research/loop-refusal-detection.md` (rows RF1 to RF8, including RF7, the stuck-signal tie-in). In flight and not duplicated: #696 (OpenRouter prices for cost and `--max-budget-usd`), loop UI #688, #697, #700, #701, and #674 (merged).

## 1. Summary

1. **The ROADMAP is stale on the CLI run limits.** `--max-budget-usd`, `--max-turns` and `--max-duration` shipped for `cn -p` and `cn serve` (commit `cc1e3d794`, 2026-11-11, `extensions/cli/src/budget/`, `docs/cli/run-limits.mdx`) with a before-the-call dollar estimate, after-the-call accounting, exit codes 20, 21 and 22, an audit `run-limit` outcome, and a user-settings-only `runLimits` that a flag can only tighten. That is T10 and T11 done, and the headless half of T3 done. Nothing in the ROADMAP records it (T3, T10 and T11 read "Not started"). T3's flag names (`--max-cost`, `--max-minutes`, `--max-tokens`) differ from what shipped and should be restated.
2. **S7 is also built and recorded as not started.** `auditToAgentSteps` and `core/tools/permissions/audit/stuckAgents.ts` (`bb18bec8e`) give per-agent stuck detection and a named note in the CLI.
3. **The largest real gap in T is a loop-wide cost (and turn) cap.** `LoopBudget` has no `maxCostUsd` or `maxTurns`; `LoopStopReason` has no `cost` or `turns`; `loopBudgetStop` (`core/util/loopMode.ts`) checks only tokens and time, and only from `decideNext`, that is between items. The cost total itself exists (`core/util/loopCost.ts`, `loopUsage().cost`, the "Cost:" line in `LoopControls.tsx`). So the work is a cap, a stop reason, a pre-request check inside an item, and a field in the dialog and `serve.loop.ts`, not a new ledger.
4. **The largest real gap in S is that nothing acts on the signals in a loop.** The CLI appends L1 notes (S2) and the shared signal backs `repeatGuard.ts`; the loop still uses its own `LOOP_REPEAT_LIMIT = 4` and never passes `stuckLevel` to `isProgressing` (`core/util/itemBudgetPolicy.ts`; `gui/src/redux/thunks/loopBudget.ts` says so in a comment), so Review at an item's limit extends nothing. The IDE has no L1 notes. S3 (does a check-in help) has a harness and no run. S1 has one session and proxy labels.
5. **Track V is entirely at the measurement stage, and one hypothesis in the plan is already wrong.** `core/util/history.ts` writes atomically under a lock (`writeAtomic`, `withSessionsLock`), not a bare `writeFileSync`; but it still rewrites the whole session as indented JSON on each save, `gui/package.json` has no windowing library, and nothing implements V0 to V8. Only request-side ageing (VA1, VA2) exists, behind `CONTINUE_HISTORY_AGEING`, core path only.
6. **Recommended 2.16.0 scope (section 8):** correct the ROADMAP first (docs, free); T0 as the loop cap with the pre-request check (M); S6 settings plus the loop reading the shared signals for `isProgressing` (S+S); S1 on loop-shaped data before any threshold edit (S); V0 harness (M, measure only). Everything that sends a check-in to a model (S3), a new UI chip (S4), a new disk format (V4) or memory notes (V9) waits for evidence or an owner decision.

## 2. State verified against code

"Done" means on `origin/main` with the cited code. Where the ROADMAP says something different the difference is flagged.

### 2.1 Track T

| Row    | ROADMAP says        | Verified                                                                                                                                                                                                                                                                                                                                                                             | Verdict                           |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| T0     | Partly built (#476) | `core/util/loopCost.ts` (`costMarkOf`, `costSince`, `loopCostUsed`, `itemCostNow`), `core/util/itemBudget.ts` enforces per-item dollars while the cost is known. No `maxCostUsd` in `LoopBudget` (`core/index.d.ts` 636 to 654), none in `LOOP_BUDGET_BOUNDS`, no `cost` in `LoopStopReason` (618 to 630). (`maxCostUsd` exists only in `core/agents/` for Track O.)                 | Partly, as stated                 |
| T1     | Partly built        | The **Cost:** line shows (`LoopControls.tsx`, `loopUsage().cost`), so the ROADMAP's "cost is not metered yet" is half stale: it is shown as a total with no limit and no meter. Turns are not counted at loop level. #701 moves the editor into `loop/LoopLimitsEditor.tsx` and a settings dialog; its fields are rounds, tokens, minutes. No stop-or-ask at a limit.                | Partly; cost is shown, not capped |
| T2     | Not started         | No presets beyond the four `LOOP_AUTONOMY` levels (`loopMode.ts` 186 to 240), each carrying its own `budget`.                                                                                                                                                                                                                                                                        | Open                              |
| T3     | Not started         | **Stale.** Headless limits shipped as `--max-budget-usd`, `--max-turns`, `--max-duration` (`runLimits.ts`, `runBudget.ts`). `cn serve` already takes a `loopBudget` message (`serve.loop.ts` 50 to 56, 253 to 264) for rounds, tokens, minutes, attempts and failures. Open: loop-level cost and turns in that message, a `/state` field naming the stopping budget, `--max-tokens`. | Mostly done; remainder small      |
| T4     | Not started         | `core/agents/` has a `budget` with `maxCostUsd` (reducer, projection) but no roll-up into the loop; O13 is the roll-up row. Parallel workers have no shared budget.                                                                                                                                                                                                                  | Open, blocked on N0 and O13       |
| T5, T6 | Built               | `itemBudget.ts`, `loopBudgetSplit.ts` confirmed present.                                                                                                                                                                                                                                                                                                                             | Done                              |
| T7     | Built               | Plan card step (#439).                                                                                                                                                                                                                                                                                                                                                               | Done                              |
| T8     | Partly built        | `itemBudgetPolicy.ts`: Suggest, Force, Review. `isProgressing` reads `stuckLevel`, but no caller supplies it (`grep stuckLevel` finds only the type and the check), so Review never extends a run that has no file change. CLI and `serve` keep "ends over budget".                                                                                                                  | Partly; blocked on S5             |
| T9     | Partly built        | `loopUsage().perItem[].cost` exists; the strip, the CLI strip and `/state` do not carry per-item meters.                                                                                                                                                                                                                                                                             | Partly                            |
| T10    | Not started         | **Done** by `cc1e3d794`: wall clock (`--max-duration`), dollars, requests, with the CLI interactive chat refusing the flags.                                                                                                                                                                                                                                                         | Stale, done                       |
| T11    | Not started         | **Done** in `RunBudget.beforeCall`: spend plus an estimate (input priced with no cache discount, output of the largest reply so far, else 1024) is tested before the request; tests exist (`runBudget.test.ts`). A scripted 95 percent case was searched for in that file and not found, so it is still open. The loop's own checks are not pre-call (below).                        | Done for headless; open for loop  |

Two structural facts that drive the design:

- `loopBudgetStop` is called from `decideNext` and (CLI) `extensions/cli/src/loop/loopBudget.ts`, so a loop budget stops a loop only between item runs. A single item run is bounded by `maxItemTurns` (60) and by an item `budget:`, nothing else. A loop-wide cost cap that is only tested between items can be overshot by one whole item run (60 requests at, say, 100K tokens each). The headless `RunBudget` shows the right shape (a check per request); the loop needs the same hook in the item driver.
- `serve` with a loop and `--max-budget-usd` set: the run limit covers "the whole server process" (`run-limits.mdx`), so the server exits with code 20 mid-loop. That is acceptable for CI but is a surprise for a long-lived `serve`; the loop-level cap should stop the loop, not the server.

### 2.2 Track S

| Row | ROADMAP says               | Verified                                                                                                                                                                                                                        | Verdict            |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| S0  | Built                      | `core/util/stuckSignals.ts` (534 lines): ten signals, not eight (`repeated-block`, `persistent-failure` added by #464), thresholds in `STUCK_THRESHOLDS`, `MONOLOGUE_OVERLAP = 0.6`; `workLog.ts`.                              | Done (ten signals) |
| S1  | Tooling built, one session | `stuckHistory.ts`, `stuckMeasure.ts`, `scripts/measureStuck.ts`; results in `stuck-calibration.md` section 2: one local Qwen session (1,113 steps), healthy-phase `stuck` 205 of 591 to 9 of 591 after fixes. No second corpus. | Open (data)        |
| S2  | Built (#446)               | CLI: `extensions/cli/src/stream/stuckNotes.ts`, called from `handleToolCalls.ts` (`noteStuckRound`); off with `CONTINUE_CLI_DISABLE_STUCK_NOTES=1`. IDE: no caller of `detectStuck` in `gui/` or the core chat path.            | Done CLI; open IDE |
| S3  | Harness only               | `core/util/stuckExperiment.ts`, `bench/scenarios/stuck-decoy.json`; no model run.                                                                                                                                               | Open               |
| S4  | Not started                | No chip. `toolboxCards.ts` has a `where-stuck` card only.                                                                                                                                                                       | Open               |
| S5  | Not started                | Confirmed. `LOOP_REPEAT_LIMIT` in `loopMode.ts` (line 475 region) and the 60-turn limit still end runs as `stuck` through their own counters; nothing escalates through M3.                                                     | Open               |
| S6  | Not started                | Only the env var exists; no `stuckDetection` key in config types.                                                                                                                                                               | Open               |
| S7  | Not started                | **Stale, built** (`bb18bec8e`): `auditToAgentSteps`, `stuckAgents`, `stuckAgentNoteOf`, wired in `stuckNoteForHistory`.                                                                                                         | Done               |
| S8  | Not started                | No second labelled corpus.                                                                                                                                                                                                      | Open               |
| S9  | Not started                | No context-growth signal in `StuckSignalKind`.                                                                                                                                                                                  | Open               |

### 2.3 Track V

| Row      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| V0       | No harness. (`core/util/cacheReplay.ts` is the cache-cost replay, V0b, not a memory harness.)                                                                                                                                                                                                                                                                                                                                                      | Open                             |
| V1       | `ResourceMonitoringService` and `ResourceDebugBar` exist in the CLI (RSS, heap, loop lag); no per-category history bytes, no `/memory`, no IDE panel.                                                                                                                                                                                                                                                                                              | Open (a debug bar exists)        |
| V2, V3   | No windowing: `gui/package.json` has no virtualisation library and `Chat.tsx` renders the whole history.                                                                                                                                                                                                                                                                                                                                           | Open                             |
| V4       | `core/util/history.ts` and `extensions/cli/src/session.ts` still write one `<id>.json` per save, now through `writeAtomic` (mode 0600) under `withSessionsLock`; `JSON.stringify(orderedSession, undefined, 2)` over the whole session. The plan's "bare writeFileSync" is out of date; the O(n) per save remains.                                                                                                                                 | Open; hypothesis partly wrong    |
| V5 to V8 | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Open                             |
| VA1      | `core/util/contextAgeing.ts` (381 lines), defaults `AGEING_KEEP_RECENT_TOOL_RESULTS = 5`, `AGEING_MIN_RESULT_CHARS = 600`.                                                                                                                                                                                                                                                                                                                         | Done                             |
| VA2      | `CONTINUE_HISTORY_AGEING` in `core/llm/index.ts`, `core/tools/builtIn.ts` (the `recall_masked_result` tool). Core path only.                                                                                                                                                                                                                                                                                                                       | Done, off                        |
| VA3, V10 | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Open                             |
| V9       | No `/memory`, no notes directory. Pieces that exist: instruction files (`instructionFiles.ts`: `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CODEX.md`, rules directories); scrub-on-write (`core/util/secretScan/scrubForDisk.ts`, used by `planStore`, `requestDump`, `logger`, `hookInput`, `core/data/log.ts`); `continuous secrets scan --history` (`historyScan.ts`); `/export` and `/import` of a session as JSON; `/compact`; `/resume`, `/fork`. | Open; most building blocks exist |

Open fork PRs touching these areas: none for V or S. #696 and the loop UI stack (#688, #697, #700, #701) touch T1/T9 display only. #701 moves the limit editor, so a cost row should be added after it merges, not before.

## 3. External research (accessed 2026-11-12 unless stated)

| Source                                                                                                                                                                | What it says                                                                                                                                                                                                                                                                                                                                                                                                                | Use here                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code CLI reference, https://code.claude.com/docs/en/cli-reference                                                                                              | `--max-turns`: "Limit the number of agentic turns (print mode only). No limit by default." `--max-budget-usd`: "Stop the run once estimated spend on API calls reaches this amount (print mode only)", checked against a client-side estimate, subagent spend counts, "Spend can pass the cap, so leave headroom". `--no-session-persistence` (print mode): sessions "are not saved to disk and cannot be resumed".         | Confirms the flag semantics the benchmarks note could not. Our headless limits are stricter (pre-call). Our `--no-session-persistence` equivalent is not on the ROADMAP: see V-rows below. |
| Claude Code memory, https://code.claude.com/docs/en/memory                                                                                                            | CLAUDE.md written by the person; auto memory written by Claude, on by default in local sessions, toggled in `/memory` (`autoMemoryEnabled`), per repository and shared across worktrees, first 200 lines or 25 KB loaded each session, machine-local; transcripts are deleted after `cleanupPeriodDays` but memory files are excluded from that sweep.                                                                      | Design reference for V9; our default differs (opt-in).                                                                                                                                     |
| Codex CLI commands, https://learn.chatgpt.com/docs/developer-commands?surface=cli (page read to 100,000 of about 143,000 characters)                                  | The `codex exec` flag table lists no max-turns, budget or timeout; `--ephemeral` ("Run without persisting session rollout files to disk"); `resume` by ID or `--last`; `fork`. Third-party write-ups of a token `rollout_budget` are in `benchmarks-toolcalls-loops.md` (secondary).                                                                                                                                        | We are ahead of Codex on headless caps; ephemeral sessions are a cheap privacy feature.                                                                                                    |
| OpenHands, searched via docs mirrors                                                                                                                                  | V0 config: `max_iterations` default 100, `max_budget_per_task` default 0.0 meaning no limit, "per-task USD cap beyond which the agent stops" in the controller source; SDK: `max_iterations` 500 and a `stuck_detection` boolean. Stuck detector docs: https://docs.openhands.dev/sdk/guides/agent-stuck-detector (read 2026-11-11 in a prior note; ping-pong at 6 cycles). The V0 and SDK defaults conflict; not resolved. | Confirms an iteration cap plus a dollar cap is the common pairing; the detector is not user-tunable.                                                                                       |
| SWE-agent, via third-party READMEs only (docs site fetch failed on a certificate error)                                                                               | `per_instance_cost_limit` default 3.0 (0 disables), `total_cost_limit` default 0 (off). Official docs not read.                                                                                                                                                                                                                                                                                                             | Per-item dollar caps are the SWE-agent norm: matches T5. **Unverified against the official docs.**                                                                                         |
| Aider, https://aider.chat/docs/config/options.html                                                                                                                    | `--max-chat-history-tokens` is a "soft limit on tokens for chat history, after which summarization begins"; `--weak-model` does the summarising; `--restore-chat-history` is off by default; `--chat-history-file` defaults to `.aider.chat.history.md`. Max reflections and cost display not on that page.                                                                                                                 | Summarisation by a cheaper model and restore-off-by-default are the Aider choices.                                                                                                         |
| SWE-Gym (arXiv 2412.21139) and SWE-smith (2504.21798), via search summary                                                                                             | "Stuck in loop" defined as the same action three times in a row; 29.4% of SWE-bench Verified tasks for the largest 32B model zero-shot (SWE-Gym). More than 25% of SWE-agent-LM-32B trajectories have a repeated sequence of length 10 or more, under 4% for Claude 3.7 Sonnet (SWE-smith).                                                                                                                                 | Loop rate depends strongly on the model: thresholds fitted on a strong model will under-fire on a small local one. Not read in full.                                                       |
| "Looping Is Not Reliability" (arXiv 2607.24604), search summary only                                                                                                  | Repetition alone gives no reliability guarantee; the title's point is that a loop that exits is not a loop that is right.                                                                                                                                                                                                                                                                                                   | Supports tying stop decisions to the item's check, not to the signal alone. Unverified.                                                                                                    |
| "When Agents go Astray" (arXiv 2509.02360) and the supervisor paper (2509.13941, 22.2% of failed issues fixed, cited in `benchmarks-toolcalls-loops.md`)              | A process reward model raised resolution 40.0% to 50.6% on SWE-bench Verified (search summary).                                                                                                                                                                                                                                                                                                                             | Evidence that an outside look at a trajectory can help, which is the S3 and T8 Review premise; cost of the extra model is not stated.                                                      |
| "Fail-Fast, Restart-Smart" (arXiv 2608.03222) and an unreviewed Notion research note on entropy collapse                                                              | Failure predicted early; looping preceded by gradual action-entropy collapse tens to hundreds of turns earlier.                                                                                                                                                                                                                                                                                                             | Possible later signal; **unreviewed**, do not schedule.                                                                                                                                    |
| Memory tool and context editing, Anthropic (links in `memory-ageing.md`: platform.claude.com `memory-tool`, `context-editing`, anthropic.com/news/context-management) | Read in the prior pass (2026-11-10); not re-read.                                                                                                                                                                                                                                                                                                                                                                           | VA3 and V10 stand on that note.                                                                                                                                                            |
| MAST failure taxonomy, 342-failure study, Koda, Pydantic AI, Calute and AG2 detectors                                                                                 | Covered in `stuck-calibration.md` sections 3 and 4; not repeated.                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                                                            |

Peer comparison that matters for scheduling: none of Claude Code, Codex or OpenHands documents a per-agent loop-level budget with a stop-or-ask at the limit, a warning at 80%, or a reserve for extensions (T1, T7, T8). Claude Code and OpenHands document both a turn/iteration cap and a dollar cap. Claude Code's own docs say spend can pass the cap; ours is documented to pass it by at most one request's estimate error. **No peer source read publishes a false-positive rate for a stuck detector**; ours (1.5% healthy-phase prefixes on one session) is the only figure and it is n = 1.

## 4. Track T: open rows

False-positive cost for budgets is different from stuck detection: a budget stop is deterministic, so the risk is a cap the person did not understand or a default that fires on healthy work. Defaults therefore stay at "off unless set" for cost (loop-budgets.md D1).

### T0b. Loop-wide `maxCostUsd` and `maxTurns` (restated T0, M)

Problem: "stop at five dollars" cannot be said for a loop, and a loop can overshoot any limit by a whole item run.

Design:

- `LoopBudget` gains `maxCostUsd?: number` and `maxTurns?: number` (0 or absent: none). `LOOP_BUDGET_BOUNDS`: cost 0.01 to 1000 with unlimited true; turns 10 to 10,000 with unlimited true. `LoopStopReason` gains `"cost"` and `"turns"`. `loopBudgetStop` returns `{ reason: "cost", detail: "Cost budget: $5.02 of $5.00" }` and the same for turns.
- Counting: cost from `loopCostUsed(loop, costMark).amount`; `"unknown"` never counts as zero and never trips. A cost cap on a loop whose current model is unpriced is refused when set (same rule as `unpricedBudgetProblem` in `runBudget.ts`: reuse `hasPrice`), and the dialog says "This model has no price here; use tokens or time". Turns: a counter `loop.turns` incremented where `maxItemTurns` is incremented today (one per model request in an item run, including re-runs).
- Where it is checked: (a) in `decideNext` as now, (b) before each model request in the item driver (CLI `loopItemRun.ts`; GUI `runLoopItemSubagent.ts`), calling one shared pure function `loopRequestAllowed(loop, ctx, estimateUsd)` that mirrors `RunBudget.beforeCall` (spend plus a no-cache-discount estimate against the cap). A refusal ends the run with outcome `over_budget` (not `failed`; loop-budgets D6) and the loop stops with reason `cost`. This is T11 for loops.
- 80% warning: `loopUsage` already returns `fraction`; add the cost fraction and a note appended to the next tool result once (cache-safe, as T5's note is). Wording: "The loop has used 80% of its cost budget ($4.02 of $5.00)."
- At the limit: stop or ask. Default **ask when a person is watching, stop when not** (loop-budgets D2). Ask is a question with "Add $2", "Add $5" and "Stop"; at IDGAF the question is not asked (`decideAlone` rules, #687), so the default there is stop, which is the safe side of "nothing asks".
- Waiting on the person does not count toward time (loop-budgets D3); verify this in code before shipping: `waitingSince` exists on items, but whether `loopBudgetStop` subtracts it is not confirmed in this pass (open check).
- Audit: loop stops already record `stopReason`; add the budget name and figures to the existing stop audit line; no new kind.
- CLI and headless parity: add `loopBudget.maxCostUsd` and `maxTurns` to `serve.loop.ts` (the existing `setLoopBudget` validation path handles bounds), and a `/state` field `budget: { stoppedBy, used, max }`. `cn -p` keeps the process-level flags; document that the process cap wins and a loop cap stops only the loop.

Alternatives rejected: a separate "cost governor" object (duplicates `RunBudget`; share its estimate function instead); per-request cost from the provider's invoice (not available live; the table estimate is what the run-limit docs already label an estimate); defaulting a dollar cap on (surprises local-model users).

False-positive cost: a cap that trips is only a false positive if the person did not set it, so none by default. Risk is the estimate error near the cap: measure it by replaying recorded request dumps (`requestDump.ts`) through `loopRequestAllowed` and comparing the estimate with the actual cost per request; report the p95 over-estimate (the headless design assumes it errs high). Cost to quantify: stopping "early" by the margin of the estimate, about one request.

Dependencies: none for core; the dialog row waits for #701 to merge. Tests: scripted ledger crossing $1 (stops after the crossing request in `decideNext`, refuses before it in the driver); unpriced model refused; unknown never trips; 95% scripted case from E9; lowering the cap below spend stops at the next check; `serve` message bounds. Size **M** (core S, driver hook M across two hosts, dialog S).

Acceptance: a loop with a $1 cap stops naming "Cost budget: $x of $1.00" and never starts a request whose estimate passes the cap; the same in `cn serve`; the dialog edits it while running; an unpriced model cannot take it.

### T1b. Meters and stop-or-ask in the dialog (S to M, after #701 and T0b)

Add a Cost row and a Turns row to `LoopLimitsEditor.tsx` and meters to `LoopUsagePanel.tsx` from `loopUsage()` (add `turns: LoopLimitUsage` and `costLimit: LoopLimitUsage` to its return; `cost` stays a number for the existing line). Wording per loop-budgets: "$1.84 of $5.00", "212 of 600 turns". A radio "At a limit: Ask me / Stop" stored as `loop.budget.atLimit`. Which limit will fire first: the one with the highest `fraction`; show it as the meter with the amber/red state that tokens already use. Accessibility: the meter is a `progress` with a text value, as the existing meters; one polite announcement at 80%, no new live region (the #700 rule). Test: dialog tests extended; axe baseline entry updated. Do not start before #701 merges (same files).

### T2. Presets (S, defer)

The four autonomy levels already carry budgets. A Frugal/Balanced/Thorough/Unlimited menu adds a second axis the person must reason about. Recommendation: do not add presets; show the level's numbers as the starting point (already done) and let the person save a named set later if asked for. If built: presets are three numbers each (cost, turns, minutes) with no behaviour beyond filling the dialog. Dropped for 2.16.0.

### T3b. Remaining CLI and `serve` parity (S)

What is left after `cc1e3d794`: loop-level cost and turns in the `loopBudget` message (T0b), a `/state` stopped-by field, a `--max-tokens` flag. Recommendation: skip `--max-tokens` for headless runs (tokens are a poor proxy, loop-budgets "Why"; no peer ships one in the docs read except Codex's secondary-source rollout budget) and keep the three flags. Restate T3 to the flags that exist. Test: `/state` snapshot contains the field after a budget stop; exit code and message unchanged.

### T4. Shared budgets across workers (L, blocked)

Depends on N0 and O13. Do not schedule. The one thing to settle early is semantics: a wave refuses to start when fewer than one item's share remains (loop-budgets), and worker spend is merged into the session total today (`runSubagent.ts`), so a roll-up subtracts children. Revisit when N0 lands.

### T8b. Review with real evidence (S, depends on S-signal wiring in section 5)

Supply `ItemProgress` from the run: `changedFiles` from the item's file-change set, `checkImproved` from the previous and last check result, `stuckLevel` from `detectStuck` over the item run's steps (see S5a). Until then `isProgressing` returns false for any item with no file change, which is correct but unhelpful. Test: scripted stuck item at each autonomy level, as the plan's "done when". The CLI and `serve` also get Suggest/Force/Review (today they just end over budget).

### T9b. Strip and CLI meters (S)

`perItem[].cost` exists. Add the closest-limit meter for the running item to `loopStrip.ts` (after #697) and one line in the CLI loop status. Low risk, display only.

## 5. Track S: open rows

Shared principle for false positives: **stopping or interrupting a healthy run is the expensive error; a late note is cheap.** The ladder already encodes it (L1 note, L2 check-in, hard stop only after L2 was ignored, never on `repeat-call` alone). Everything below keeps L1 as the only automatic action until S3 has data.

### How to measure false positives (S1 and S8, one plan)

Data that exists: one 309 MB local session (n = 1). Data that is cheap to make: bench loop scenarios through `bench/runner.mjs` with `state.json` kept, and the person's own sessions under `~/.continuous/sessions`, `~/.claude/projects` (read-only, via the same adapters as `historyScan.ts` roots). Plan:

1. Label rule fixed in advance, before any measurement: **stuck** run segment = the item's check never passed and the segment used more than 80% of its turn budget; **healthy** = the check passed or the item finished `done` within budget. A segment is one item run (loops) or one user message (chat). Plus a hand-label pass of 20 minutes per session for the few that disagree.
2. Target: at least 20 healthy and 10 stuck segments per model, two models at least (a strong hosted one and a small local one, because loop rates differ by model: SWE-smith's under 4% against over 25%).
3. Metrics per signal and for the combined report: fire rate on healthy segments (the false-positive rate, with a Wilson interval, the method used elsewhere in the repo), recall on stuck segments, lead time in steps and in prompt tokens before the budget ended the run.
4. Gate (from the plan): a signal that fires on more than 5% of healthy segments at `stuck` is tightened or dropped **before it is allowed to act**; at `note` the bar is 15%, because a note costs about 40 tokens and one tool-result line.
5. Cost of a false positive, to be reported with the rate: L1 note about 40 output-free tokens plus the risk the model changes a correct course (measure by the next-call change rate on healthy segments); L2 check-in one extra request (at the session's mean prompt size, from `usage`) plus the same risk; L4 stop costs the whole remaining work, which is why it needs L2 ignored.

### S1b. Re-measure on loop-shaped data (S, 2.16.0)

Run `measureStuck.ts --segment-by-user` over the bench loop scenarios and any new recorded loop session; record the table in `stuck-calibration.md` section 2. No threshold edit unless the gate fails. This is data collection, no product code beyond a `labels.json` reader.

### S5a. The loop reads the shared signals (S, 2.16.0)

Problem: the loop ends a run as `stuck` on `LOOP_REPEAT_LIMIT = 4` or its 60-turn limit, and Review at an item's limit cannot tell progress from churn.

Design: at the end of an item run (and at its limit), compute `detectStuck(steps)` over that run's steps (`stuckHistory.ts` for the CLI/IDE history, or `auditToAgentSteps` for a worker) and record the strongest level in the item's report (`LoopItemState` gets an optional `stuck?: { level, kinds }`). Pass it to `ItemProgress.stuckLevel`. Do not change what ends a run yet; `LOOP_REPEAT_LIMIT` stays until S1b shows the shared `repeat-call` signal matches it. Audit: one record per run with the kinds (reuse the audit kind used for the L1 notes; reader and index sized first, as RF3 says). Wording in the report: "Looked stuck: the same test failed the same way 4 times across your edits." Test: scripted runs from the 23-history corpus feed `isProgressing`; an item at its turn limit with a `persistent-failure` stop signal is not extended; one with file changes and no signal is.

Dependencies: S0, #439. Ties to RF7 (question-loop signal) and RF2: they share the item-report field, so land one field for all three.

### S6. Settings and per-signal thresholds (S, 2.16.0)

`stuckDetection: off | notes | full` (config.yaml and `settings.json`, user-level only so a repository cannot turn off a person's guard), default `notes` (current behaviour). `full` is reserved for L2 and stays unavailable until S3 reports; document it as "not yet". Per-signal thresholds are exported already; expose a `stuckThresholds` override validated against `{ note, stuck }` with `note <= stuck`, clamp to at least 1. Keep `CONTINUE_CLI_DISABLE_STUCK_NOTES=1` as an alias. Tests: each value; a project file cannot loosen; invalid thresholds ignored with a warning. UI: one line in the settings page (`notes` on/off); do not add per-signal threshold UI. Size S.

### S2b. IDE notes (M, later)

Wire `stuckNoteForHistory` into the IDE's tool-result path (core chat path plus the GUI tool-call flow). Cache rule: append to the newest result only. It is the only way the IDE gets L1. Recommendation: after S1b, because the IDE sessions are where healthy long runs are most common (person in the loop) and a false note there costs trust. Test: the same corpus through the IDE adapter; byte-identical request prefix with the feature off.

### S3. The check-in experiment (M, run, do not build)

The harness is fixed (`stuckExperiment.ts`, 2 arms, n = 10 per arm per model, bar fixed in code, `stuck-decoy`). Run it once on a hosted model and once on a local one (about 40 requests per run at cents on Bedrock small models per the existing estimate; local free). Decision it informs: whether `stuckDetection: full` is worth building. Not 2.16.0 unless the owner approves the spend in the "Pre-registered benchmark spend" decision (currently "not approved", ROADMAP open decisions).

### S4. Chip and work log view (M, after S3)

If S3 shows a lift, the chip and the Work log view. If it does not, S4 becomes only the work log view (derived, no model). Chip wording: "Looks stuck: the same test failed 3 times" with a button into the `where-stuck` toolbox card. A11y: a status role, not an alert, no live region of its own (the loop announcer rule). Not 2.16.0.

### S8. Second labelled corpus (M)

Folded into S1b's plan: five sessions on two models labelled by the owner or by the label rule. Done when each signal has a table row with n above 20 healthy segments.

### S9. Context-growth signal (S, defer)

Evidence is thin (the OpenHands "repeated context window errors" pattern has no numeric threshold; unreviewed notes link growth with entropy collapse). Replay on the existing `long-read` runs first (E7); build the signal only if it separates runaway from healthy long runs. Defer; compaction already handles the cost side.

## 6. Track V: memory and session history

### What is stored today (verified)

- **Sessions on disk**: one `<id>.json` per session in the global sessions directory (`getSessionFilePath`), written with `writeAtomic` (temp file, mode 0600) under `withSessionsLock`, plus a `sessions.json` list updated per save (`updateSessionsList`). The file holds the full `history`, `usage`, `promptCache`, `checkpoints`, `taskPlan`, `planFile`, `queuedMessages`, `loop`. No retention or cleanup was found; sessions are kept until deleted. The CLI has the same shape (`extensions/cli/src/session.ts`).
- **Redaction**: sessions are **not** scrubbed on write (they must round-trip for resume; `scrubForDisk` says so). Dumps, logs, plans, hook inputs and the audit are scrubbed. `continuous secrets scan --history` reads `sessions`, `dev_data`, `logs` read-only. So a secret the model echoed is in the session file in clear text; the 0600 mode and local-only storage are the protection.
- **Search**: none over history beyond the session list title; **resume**: `/resume`, `/fork`, `--resume`, `--continue`; **export**: `/export` and `/import` JSON.
- **Model-side**: `/compact` and auto-compaction (`AUTO_COMPACT_BUFFER_RATIO = 0.8`, `contextManagement.autoCompactRatio`), and request-side masking behind a flag.
- **Memory (notes)**: none. Instruction files are loaded whole and are the person's.

### V0. The measurement harness (M, 2.16.0, measure only)

Everything else in V is gated on numbers, so V0 goes first and ships no behaviour. Design: a script in `bench/` (not in a release) that synthesises sessions of 1k, 5k and 20k items from a distribution taken from the real 1,113-step session (tool-output size histogram, image share, reasoning share), then for each of core (`historyManager.save` time, transient heap during `JSON.stringify`, file bytes), CLI (`ChatHistoryService` heap, `saveSession` time) and GUI (Redux retained size by category via a heap snapshot, DOM node count of the chat container, render time of the last item, time to open) records a row. Done when the table exists in `memory-and-history.md`. Plan hypotheses to confirm or drop: save cost O(n) per save; DOM linear; images base64 in history. Open check this pass could not make: webview heap numbers need a real browser run (Playwright harness in `bench/screenshots` is a candidate). Size M. Risk: none to users.

### V1. Statistics and `/memory` for process memory (S to M, after V0)

Local only. Name collision to settle: V9's `/memory` (notes) and V1's `/memory` (process figures) cannot both be `/memory`. Recommendation (pending owner): V1 is `/usage memory` or `/resources`; `/memory` belongs to notes, matching Claude Code's meaning of the word. The CLI already has `ResourceDebugBar`; V1 is mostly exposing it plus byte counters per category.

### V2 to V3. Cheap wins and windowing (M each, after V0)

Do V2 first only for what V0 names. Windowing (V3) is the largest user-visible win for long loops but touches `Chat.tsx`, scroll restoration and accessibility (a virtualised list hides items from screen readers: keep a "N earlier items" button and load-earlier, not infinite virtualisation, and keep keyboard reachability). It collides with #700 and the loop UI stack in `Chat.tsx`; schedule after they merge.

### V4. Append-only session log (L, defer)

Design in the plan stands (JSON lines plus an offset index, large bodies as files, a loader for the old format, migrate on first open). Reasons to defer: it changes the session format that `/import`, `/resume`, ACP `session/list` (O24) and `continuous secrets scan --history` read; the 0600 and lock semantics must be preserved per file; and V0 may show the per-save cost is not the bottleneck. Decision D1 of the plan (log versus SQLite) is made after V0: if search is the pressure (V8) SQLite (already shipped for the codebase index) is the simpler path to range queries; if it is crash safety and cost per save, JSON lines. Recommendation, pending owner: JSON lines. A cheaper step that is not on the ROADMAP: stop pretty-printing (`JSON.stringify(..., undefined, 2)` roughly doubles whitespace on indented tool output) and skip the save when nothing changed; measure in V0 before proposing.

### V5 to V8 (L, defer)

Tiers, "Free memory" and "Export and trim", loop transcripts by reference, search over cold history all follow V0 and V4. Keep the plan's rule that nothing inside the context window ages (D3) and that "Free memory" deletes nothing (D4). V7 (loop and workers) depends on N0.

### VA3 and V10 (M, after a decision)

VA3 (window setting, a cold-cache clock in the ledger, a priced note) is the step between "behind an env var" and "a user can turn it on". It changes what the model is sent, so it needs the task-success measurement that VA2 explicitly lacks. Recommendation: do not flip the default; run the VA2 flag on the stuck-decoy and loop scenarios (success and cost per arm, n = 10) to see whether masking hurts recall of earlier results. V10 (Bedrock context editing): replay on request dumps first, as the row says; no beta header until then.

### V9. Opt-in repository notes (M, owner decision first)

What would be stored: markdown notes written by the agent into `.continuous/memory/` per repository, outside git by default; the person's rules (`AGENTS.md` and friends) stay the person's. Privacy: opt-in per repository; scrub on write with `scrubForDisk` (profile `at-rest`), refusing to write when the scrubber changes more than a few lines (a suspect paste of a credential file); never shared with a model provider other than as part of the request the person already sends; no sync. Load budget: 200 lines or 25 KB (the Claude Code figures, read 2026-11-12), loaded as one cache segment so the prefix stays stable (Track C). Retention: kept until deleted; a visible "delete all notes for this repo" and a zip export. Resume: independent of sessions. Search: none in v1; full text later over the V4 log. Secrets: also scan notes with `continuous secrets scan` roots (add the notes directory). Prompt-injection concern: model-written notes are an instruction-persistence channel (an injected page could write "always run X" into notes that load every session). Mitigation to specify before building: notes load as context labelled untrusted-written, never as rules; tool-result text is not copied into a note verbatim; a diff is shown for each write at the person's approval level; and the Track X injection tests get a "poisoned note" case. That risk, not engineering, is why this is an owner decision and why it is not a quick win. Size M plus the injection tests.

### Retention and `--no-session-persistence` (S, new, owner decision)

Neither Claude Code nor Codex keeps sessions forever by default in the same way (Claude deletes after `cleanupPeriodDays`; the default was not read this pass, so do not quote one), and both offer a no-persistence mode (`--no-session-persistence`, `--ephemeral`). Ours keeps every session indefinitely, unscrubbed. Proposal: a `history.retentionDays` setting (default off, no deletion) and `--no-session-persistence` for `-p`, with `continuous sessions prune --older-than`. Small and privacy-positive; it fits PV track ("the fork collects no telemetry"). Open question 5.

## 7. Dependencies and critical path

```
ROADMAP correction (docs)
        |
        +--> T0b (loop cap, pre-request) --> T1b (dialog rows, after #701) --> T9b
        |             |
        |             +--> T3b (serve field)         T4 (blocked on N0, O13)
        |
        +--> S1b (loop-shaped data) --> S5a (signals into item report) --> T8b (Review has evidence) --> S5 (escalate)
        |             |                         |
        |             +--> S6 (settings)        +--> RF2/RF7 share the report field
        |             +--> S2b (IDE notes) --> S3 (run, owner spend) --> S4 (chip)
        |
        +--> V0 (harness) --> V1, V2 --> V3 (after loop UI stack) --> V4 --> V5..V8
                                             VA2 evaluation --> VA3 --> V10
        V9 (owner decision + injection tests) is independent of V0
```

Critical path for the biggest user-visible result (a loop that stops on money and knows why an item is stuck): T0b, S1b, S5a, T8b.

## 8. Recommended build order

1. **ROADMAP correction** (docs, free): mark T10 and T11 built, T3 mostly built and restated, S7 built, S0 ten signals, T1 cost shown; record `cc1e3d794`.
2. **T0b** loop `maxCostUsd` and `maxTurns` with the pre-request check and a stop reason (M). Quick win with the highest value: closes the one real way to overspend in a loop.
3. **S6** `stuckDetection` setting (S). Quick win: a person can switch the notes off in config, which today needs an environment variable.
4. **S1b** loop-shaped re-measurement (S, data) and **S5a** item report field (S). Without them T8 stays inert.
5. **V0** harness (M, measure only), to decide V4's priority with a number.
6. **T1b**, **T9b**, **T3b** after #701 and #697 merge (S each).
7. Then by evidence: S2b, S3, S4, VA3, V2, V3.

2.16.0 candidates: items 1 to 5 plus T3b and T1b if #701 has merged. Later: S3, S4, S2b, S9, V1 to V8, VA3, V10, T2, T4. Defer or drop with reasons: **T2 presets** (second axis, no demand evidence); **`--max-tokens` for `cn -p`** (poor proxy, no peer ships it from primary sources); **S9** (no threshold, thin evidence); **V4 as proposed** until V0 shows the bottleneck; **U-track style provider threads** not in scope.

## 9. Test plan summary

| Row      | Tests                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0b      | Scripted ledger and model: crossing, pre-call refusal, unknown cost, unpriced refusal, 95% case, lowering below spend, `serve` message bounds, time not counting waits |
| S5a, T8b | Corpus histories into `isProgressing`; item at limit by autonomy level; field present in the report; audit line                                                        |
| S6       | Settings matrix; project file cannot loosen; thresholds clamped                                                                                                        |
| S1b      | `measureStuck.ts --segment-by-user` on the bench scenarios; Wilson intervals in the table                                                                              |
| V0       | The harness is itself the test; CI runs a 1k smoke size only                                                                                                           |
| V9       | Scrub-on-write; refuse on suspect paste; load budget; poisoned-note injection case; delete and export                                                                  |

## 10. Open questions for the owner

1. **Loop cap default.** Add `maxCostUsd` to loops with no default (off until set). Recommended, pending owner. Alternative: a default of a few dollars at Unattended and IDGAF only, since nobody is watching.
2. **At the limit: stop or ask.** Ask when a person is watching, stop when not; at IDGAF always stop (nothing asks). Recommended, pending owner.
3. **Process cap versus loop cap in `serve`.** Keep `--max-budget-usd` as the whole-process cap (exit 20) and add the loop cap as a separate stop that ends only the loop. Recommended, pending owner.
4. **`stuckDetection` default and scope.** Default `notes`; `full` unavailable until S3 reports; user-level setting only. Recommended, pending owner.
5. **Approve the S3 spend** (two models, 40 runs each, cents to a few dollars hosted). Recommended: approve after S1b and S5a land, so the check-in is tested in the loop it would run in. Pending owner.
6. **Session retention and `--no-session-persistence`.** Add both, off by default (no deletion). Recommended, pending owner.
7. **Name of V1's command**, `/resources` or `/usage memory`, leaving `/memory` for notes. Recommended, pending owner.
8. **V9 repository notes.** Build only with the poisoned-note defence and approval-per-write; default off. Recommended, pending owner; the ROADMAP lists it as "not built" under open decisions.
9. **V4 format** (JSON lines or SQLite). Decide after V0. Recommended default JSON lines, pending owner.

## 11. Proposed ROADMAP changes (exact text; not applied)

Rows to replace (keep the table format; ids unchanged):

- **S0** state: `Built (#414, #464): ten signals as pure functions with exported thresholds (the eight of the plan plus repeated-block and persistent-failure), a derived work log and a labelled corpus; adapters for CLI and IDE histories and the audit trail`
- **S2** state: `Built for the CLI (#446, #464): L1 notes in tool results (CONTINUE_CLI_DISABLE_STUCK_NOTES=1 turns them off); the IDE is not wired (S2b)`
- **S7** state: `Built (bb18bec8e): auditToAgentSteps groups by agent, stuckAgents names the agent that repeats, the CLI note says which`
- **S5** scope append: `The loop passes the shared signals' strongest level into ItemProgress.stuckLevel and records it in the item report (S5a, S, 2.16.0 candidate); escalation and the stop report follow S3`
- **S6** state: `Not started (S, 2.16.0 candidate): stuckDetection off, notes (default), full (reserved until S3), user-level only; per-signal thresholds validated; the env var stays as an alias`
- **S1** state append: `Next: S1b, the same tooling on loop-shaped bench runs with a label rule fixed in advance (research/area-budgets-stuck-memory.md section 5)`
- **T0** scope: `loop-wide maxCostUsd and maxTurns in LoopBudget, stop reasons cost and turns, a pre-request check in the item driver (a loop's version of T11), 80% note, stop or ask at the limit, an unpriced model cannot take a cost cap`; state: `Partly built (#476): per-item dollars and the loop's cost total; the loop cap, stop reasons and pre-request check are not built (M, 2.16.0 candidate); research/area-budgets-stuck-memory.md section 4`
- **T1** state: `Partly built: the dialog (#701) holds rounds, tokens and minutes with meters; the loop's cost is shown as a total (no limit); cost and turns rows and stop-or-ask follow T0 and #701`
- **T3** scope: `cn serve loopBudget message takes maxCostUsd and maxTurns; /state names the budget that stopped the loop`; state: `Mostly built: cn and cn serve have --max-budget-usd, --max-turns and --max-duration with exit codes 20 to 22 (cc1e3d794, docs/cli/run-limits.mdx); the loopBudget message exists for rounds, tokens and minutes; remaining: loop cost and turns, the /state field. No --max-tokens`
- **T10** state: `Built (cc1e3d794): --max-duration, --max-budget-usd and --max-turns for cn -p and cn serve; the interactive chat refuses them`
- **T11** state: `Built for headless runs (RunBudget.beforeCall, estimate with no cache discount); for loops it is part of T0`
- **T2** state append: `Update 2026-11-12: PARKED: the autonomy levels already carry budgets; presets add a second axis with no evidence of demand`
- **T8** state append: `Review is inert until ItemProgress is supplied (S5a); then T8b wires it and gives the CLI and serve the same policies`

New rows:

| ID  | Scope                                                                                                                                                                                                                                                           | Depends on | State                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| S10 | Re-measure the signals on loop-shaped data: bench loop scenarios and recorded sessions, label rule fixed before measuring (stuck: check never passed and over 80% of the turn budget), Wilson intervals, gate 5% healthy at `stuck` and 15% at `note`; folds S8 | S1         | Not started (S); from `research/area-budgets-stuck-memory.md` |
| S11 | Loop item report carries `stuck: { level, kinds }` from the shared signals, supplied to `ItemProgress.stuckLevel`; one field shared with RF2 and RF7                                                                                                            | S0, T5     | Not started (S)                                               |
| S12 | IDE L1 notes: `stuckNoteForHistory` wired into the IDE tool-result path, byte-identical request prefix when off                                                                                                                                                 | S10, S6    | Not started (M)                                               |
| T12 | Loop-level pre-request check: `loopRequestAllowed` shared by the CLI and IDE item drivers, mirroring `RunBudget.beforeCall`; replay of request dumps to report the estimate's p95 error                                                                         | T0         | Not started (M); part of T0                                   |
| T13 | Settle whether waiting on the person is excluded from the loop's time (loop-budgets D3): check `loopBudgetStop` against `waitingSince` and add the exclusion with a test if missing                                                                             | none       | Not started (XS)                                              |
| V11 | `history.retentionDays` (default off), `continuous sessions prune --older-than`, and `--no-session-persistence` for `-p`; sessions stay unscrubbed because they must round-trip, so the setting and the docs say so                                             | none       | Not started (S); owner decision                               |
| V12 | V0 correction: `history.ts` already writes atomically under a lock; the cost left is the whole-session rewrite and `JSON.stringify(..., undefined, 2)`; measure compact output and skip-if-unchanged before V4                                                  | V0         | Not started (S, measure)                                      |

Open decisions to add: loop cost cap default; stop-or-ask at the limit; `stuckDetection` default; S3 spend approval; session retention; the command name for process memory.

## 12. Unverified and limits of this pass

- SWE-agent limits are from third-party READMEs; the official docs host failed a certificate check. OpenHands defaults conflict between V0 and SDK pages. SWE-Gym, SWE-smith, "Looping Is Not Reliability", "When Agents go Astray" and "Fail-Fast, Restart-Smart" are from search summaries, not read in full. The entropy-collapse note is unreviewed. Codex's CLI page was read to 100,000 of about 143,000 characters.
- Claude Code's `cleanupPeriodDays` default was not read; no figure is stated.
- Not checked in code: whether `loopBudgetStop` excludes waiting time (T13); the GUI webview heap at any size (V0); the scripted 95 percent test (a grep of `runBudget.test.ts` for it found nothing).
- No measurement was run in this pass; all rates quoted are from existing notes.
