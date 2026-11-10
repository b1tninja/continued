# Loop reliability: what makes long agent loops finish real work, and what Loop mode lacks

Written 2026-11-10. Status: research and one built slice. Sources were read on 2026-11-10; claims that came only from a search snippet or a secondary page are marked **UNVERIFIED** and collected at the end. Nothing here changes a default.

## 1. Decisions in short

1. **Build the fallback check (done).** Before this change, an item with no `check:` was marked done on the model's own `finish_item`. `LoopState.fallbackCheck` (off by default) holds every such item to one command the harness runs itself, the way a to-do's own check already is. It is the smallest change that makes "done" mean something for plans the planner left without checks.
2. **Next, a progress file the harness writes, and a clean-state note.** Nothing in the loop writes progress to disk: the loop's state lives in the session file only (no `serializePlanFile` or file write anywhere in `extensions/cli/src/loop/` or `gui/src/redux/thunks/loop.ts`). Anthropic's harness, Codex's long-horizon recipe and Ralph all rely on a file the next context can read. Not built here; section 6.
3. **Keep a fresh context per item for small local models.** Anthropic dropped context resets for Opus 4.6 and relies on compaction, but the reason was that the model no longer showed "context anxiety". Our target models are small and local, and the one long recorded session shows 1,113 steps for 12 reports. Keep `freshContext` on by default and treat it as a setting to measure, not a fixed choice.
4. **Add an independent verifier only for items with no runnable check.** A model judging its own work is the weakest gate; a separate judge is the next one (L6 item 6, not built); a command the harness runs is the strongest and the cheapest. Spend the verifier call only where no command exists.
5. **Do not touch decomposition granularity yet.** The evidence on task size is thin and secondary (section 4). The plan already asks for "one reviewable change that one check can verify".

## 2. What the harnesses do

### 2.1 Anthropic, "Effective harnesses for long-running agents" (2025-11-26)

https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

- **Initializer, then coding agent.** The first session sets up `init.sh`, a progress log and a first commit. Every later session makes incremental progress and leaves structured updates.
- **Progress file plus git history** are how a fresh context learns the state.
- **A feature list as JSON, all failing at first**, 200+ entries in the example. Coding agents may change only the `passes` field. The post chose JSON because "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files".
- **One feature per session.**
- **Clean state at the end of a session:** code "appropriate for merging to a main branch", with descriptive commits and progress notes.
- **Premature done is the named failure.** The post's table lists "declares the project finished too early" and "marks features done prematurely", and says agents often marked features done after unit tests or curl checks alone; performance improved when told to test as a human user would, with browser automation.

### 2.2 Anthropic, "Harness design for long-running application development" (2026-03-24)

https://www.anthropic.com/engineering/harness-design-long-running-apps

- **Reset versus compaction.** A reset clears the window and starts a fresh agent with a structured handoff; compaction summarises in place and keeps continuity without a clean slate.
- **Context anxiety:** Sonnet 4.5 wrapped up early as it sensed the limit, so compaction alone was not enough and resets were essential to that harness.
- **Generator and evaluator are separate.** Agents "tend to overrate their own work"; tuning a standalone evaluator to be sceptical is easier than making the generator self-critical.
- **What changed with Opus 4.6:** resets and the sprint construct were dropped, the evaluator moved to one end-of-run pass, and the planner stayed (without it the generator under-scoped).

### 2.3 OpenAI, "Run long horizon tasks with Codex" (undated; mentions GPT-5.3-Codex)

https://developers.openai.com/blog/run-long-horizon-tasks-with-codex.md

A 25-hour, about 13M-token, about 30k-line run, which the author calls an experiment. The recipe: a frozen spec with "done when" criteria; a plan of milestones "small enough to finish in one loop", each with acceptance criteria and validation commands; a stop-and-fix rule (repair a failure before moving on); a documentation file that is shared memory and audit log (status, decisions with reasons, run commands, known issues); lint, typecheck, tests and build after every milestone; decision notes to stop oscillation.

### 2.4 The Ralph loop and its failure modes (community, January 2026)

Sources: https://stevekinney.com/writing/the-ralph-loop, https://ai-assisted-software-development-com.pages.dev/ralph-wiggum-loop-january-2026-snapshot, https://www.besthub.dev/articles/why-ai-coding-assistants-quit-early-and-how-ralph-loop-keeps-them-working-d02d1b9e302f. All are practitioner write-ups, not official documentation, and none quantifies a rate.

- **"Hallucinated done":** the model emits the completion marker without running checks. Remedy: a stop hook that forces continuation until verifiable criteria pass.
- **Livelock by infinite subtasks:** "while I'm in here" items never shrink the list. Remedy: an explicit definition of done, with every line under it checked.
- **Context rot** from building on its own mistakes, with fresh-context iterations as the remedy. The claimed drop in adherence "after about 100k tokens" is unsourced (**UNVERIFIED**).
- **Iteration caps** (10 to 25) as circuit breakers; unsuitable where there is no objective success metric.

`plans/loop-mode.md` already records Ralph's design from its primary sources; this adds the failure modes.

### 2.5 OpenHands, Devin, Claude Code, Kiro

`plans/loop-mode.md` (table "What other harnesses do") already compares these. New from this pass: OpenHands' guide says a task with a very clear success criterion does better and that very long tasks may time out, with "break them into smaller tasks" as the workaround (https://docs.openhands.dev/openhands/usage/essential-guidelines/when-to-use-openhands). No official Devin or OpenHands plan-file or per-milestone verification design was found (**UNVERIFIED** for Devin's plan-execute-verify beyond what the plan already notes).

## 3. Evidence on verification

- **Agent-written tests add little.** A study of six models on SWE-bench Verified found current test-writing practices give marginal utility and that the volume of agent-written tests does not significantly change outcomes (https://arxiv.org/html/2602.07900, 2026).
- **Agents under-verify.** A study of 16,991 SWE-agent trajectories reports agents give up on reproduction tests early and validate with existing regression tests (https://arxiv.org/pdf/2604.02547, 2026; a secondary summary, **UNVERIFIED** in detail).
- **Self-judged success is inflated:** ADaPT's executors overstated success by more than 30 points on WebShop (cited in `plans/loop-mode.md`); MAST puts incorrect, missing or incomplete verification at about 17% of failed multi-agent traces (same file).
- **Long-Horizon-Terminal-Bench (July 2026)** names timeouts and weak self-verification as the main bottlenecks (secondary source, **UNVERIFIED**).
- **Gating on a command works in practice** in every harness read: Codex runs validation commands per milestone; Anthropic's table makes the coding agent verify before flipping `passes`; Kiro, `/goal` and agent-team `TaskCompleted` hooks gate done on something other than the agent's word (`plans/loop-mode.md`).

Reading: the command the harness runs itself is the only gate with no model in it. The gap in our loop is not the gate but the items that have none.

## 4. Granularity, handoffs, small models

- **Granularity.** Codex: milestones "small enough to finish in one loop". Anthropic: one feature per session. Ord's analysis, as summarised by a secondary source, finds success falling roughly exponentially with task length, which would favour smaller items; this is an interpretation, not a measurement of subtask size (**UNVERIFIED**; METR's time-horizon figures differ between versions 1.0 and 1.1, January 2026). No study found isolates subtask size against coding-agent success. Treat "smaller is better" as a hypothesis the runs should test.
- **Handoff artifacts.** Three independent harnesses (Anthropic's progress file and JSON list, Codex's documentation file, Ralph's `IMPLEMENTATION_PLAN.md`) use a file the next context reads. Per-item git commits are in Anthropic's recipe ("descriptive git commits"); for Codex a commit per milestone is **UNVERIFIED** (no source required it).
- **Small and open models.** SWE-Gym reports zero-shot open-weight models often repeat the same action and that the largest 32B model is trapped in 29.4% of SWE-bench Verified tasks (https://arxiv.org/pdf/2412.21139). SWE-Bench Pro reports Qwen3 32B with the highest tool error rate, 42.0% (https://arxiv.org/pdf/2509.16941). SWE-EVO finds kimi-k2, qwen3-coder and gpt-oss-120b fail mainly on incorrect implementation with stable tool use, and links looping and early termination to older models (https://arxiv.org/pdf/2512.18470). A DeerFlow issue shows a turn budget mimicking premature termination. No study isolates small Qwen models' early "done" rate (**UNVERIFIED**). Our own measurement: one recorded local-model session had 12 `finish_item` calls in 1,113 steps (`plans/stuck-calibration.md` section 2.1).

## 5. Comparison: practice against what our loop does

| Practice                                                                     | Source                                 | Our loop today                                                                                                                      | Evidence                                                                                       | Gap                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Fresh context per unit of work, state on disk                                | Ralph; Anthropic 2025-11               | Fresh context per item (`freshContext`, default on); state in the session file                                                      | `plans/loop-mode.md` "What the Ralph loop changed"                                             | State is not on disk as a readable file                                                      |
| A file the next context reads (progress file, documentation file, plan)      | Anthropic; Codex; Ralph                | `Session.loop` in the session JSON; the plan file is read at start and at re-plan, never written back                               | No file write in `extensions/cli/src/loop/*.ts` or `gui/.../thunks/loop.ts` (grep, 2026-11-10) | **Yes: no progress file**                                                                    |
| Only the harness flips pass/fail                                             | Anthropic ("only change `passes`")     | `finish_item` reports; the harness sets status; the loop hides the task list tool while an item runs                                | `core/util/loopMode.ts` `statusAfterRun`, `finishRunOf`                                        | None                                                                                         |
| Done gated on a command the harness runs                                     | Codex, Anthropic, Kiro, `/goal`        | Built for items with `check:` (the harness runs it, exit 0 confirms, output goes back on failure)                                   | `recordCheck`, `decideNext` "check" action                                                     | **An item with no check was done on its own report.** Closed by the fallback check (this PR) |
| The model must not weaken the gate                                           | Codex "stop-and-fix"; our own run data | A re-plan that changes a failing check is held (`replanConcern`); the check comes from the plan, not the model                      | `loopMode.ts` `replanConcern`; its comment records 3 of 6 runs doing it                        | Edits to the tests inside an item's run are not detected                                     |
| One unit per session                                                         | Anthropic; Codex                       | One item per run, order set by the harness                                                                                          | `decideNext`, `nextRunnableItem`                                                               | None                                                                                         |
| Clean state at unit end (committable, builds)                                | Anthropic                              | Not checked. Commits deliberately off (plan decision). No uncommitted-file or build check                                           | `plans/loop-mode.md` "A commit per item: not taken for now"                                    | **Yes**                                                                                      |
| A progress note per unit: what was done, what the check showed, what is next | Anthropic; Codex                       | `summary` clipped to 160 characters in the plan block; `notes` (12 x 300 characters); `remind_me` for later runs. All model-written | `LOOP_PLAN_BLOCK_LIMITS`, `appendNote`, `plans/loop-mode.md` "Reminders"                       | Partly: no harness-written facts (check result with output tail, files changed)              |
| Separate evaluator, not the generator                                        | Anthropic 2026-03                      | Not built (L6 item 6, "Done first" proposed)                                                                                        | `plans/loop-mode.md` rows 6 and "Proposed: what does done look like"                           | Yes, by design; only needed where no command exists                                          |
| An explicit definition of done                                               | Ralph; Codex "done when"               | Per-item `check:`; no goal-level done criteria                                                                                      | Same proposal, not built                                                                       | Yes, proposed                                                                                |
| Stuck detection                                                              | OpenHands; Kiro                        | Built: repeat limit 4, item turn limit 60, no-progress stop, 3-failure stop                                                         | `LOOP_LIMITS`, `plans/stuck-detection.md`                                                      | Signals measured on one session only (`stuck-calibration.md`)                                |
| Re-plan on failure, not every step                                           | ADaPT; Kiro                            | Fix forward, check-in strategies                                                                                                    | `LOOP_STRATEGIES`                                                                              | None                                                                                         |
| Iteration caps                                                               | Ralph                                  | `maxRounds`, tokens, wall time, per-item budgets                                                                                    | `LOOP_AUTONOMY`                                                                                | None                                                                                         |
| Reset versus compaction                                                      | Anthropic 2026-03                      | Reset (fresh context); compaction applies inside a long run                                                                         | `loop-mode.md` Fresh context                                                                   | A measured comparison on our target models                                                   |

## 6. Ranked gaps, and what was built

| #   | Gap                                                | Value                                                   | Risk                                                          | Built here               |
| --- | -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------ |
| 1   | Items with no check are done on the agent's report | High: premature done is the failure every harness names | Low if off by default                                         | **Yes: `fallbackCheck`** |
| 2   | No progress file; state only in the session        | High for resume, crashes, and a person reading it       | Medium (file writes from the gui, the plan file's own format) | No                       |
| 3   | No clean-state check at item end                   | Medium                                                  | Low in the CLI; the IDE needs `ide.subprocess("git status")`  | No                       |
| 4   | Handoff is model-written only                      | Medium                                                  | Low                                                           | No                       |
| 5   | Test tampering inside a run                        | Medium                                                  | Needs a diff of check-referenced files                        | No                       |
| 6   | No independent verifier for check-less items       | Medium                                                  | A model call per item                                         | No (existing proposal)   |
| 7   | Goal-level done criteria                           | Medium                                                  | Plan-file change                                              | No (existing proposal)   |

### 6.1 What was built: the fallback check

- **Setting.** `LoopState.fallbackCheck?: string`, off when missing. A command of at most 300 characters.
- **Core** (`core/util/loopMode.ts`): `itemCheck(loop, task)` returns the item's own `check:` else the fallback else nothing. `decideNext`, `reconcileLoop`, the re-plan guards (`replanConcern`, `startReplan`'s recorded checks, `acceptReplan`), the plan block, the task list note and the item prompt all read it through that one function, so a fallback result is not mistaken for a check the model changed. `createLoop({fallbackCheck})` and `setLoopFallbackCheck(loop, command)` (an empty command clears it; a check-pending item settles as done at the next step, as when a check is removed).
- **CLI.** `finishRun` and the wave's finish use `itemCheck`. The TUI reads `CONTINUOUS_LOOP_FALLBACK_CHECK` when it starts a loop from a plan. `cn serve` takes `loopFallbackCheck: "<command>"` (empty string clears; refused if not a string or over the limit), applied after `loopAction: "start"` in the same request.
- **IDE.** The two finish sites in `gui/src/redux/thunks/loop.ts` use `itemCheck`; `startLoopFromPlan` takes `fallbackCheck`. There is no settings control for it in the webview yet, so the IDE honours a loop that carries the field but cannot start one with it from the UI. Core is imported by the webview but `@continuedev/openai-adapters` is not touched.
- **What the model sees.** Its prompt says which command will run and that it must exit 0; the plan block labels it "(the loop's check for every item)".
- **Risk to know.** A project whose tests already fail will fail every item's check, and three failures in a row stop the loop. The person should run the command once first. A baseline run by the harness at loop start is the obvious follow-up.
- **Tests.** `core/util/loopFallbackCheck.vitest.ts` (10 tests), CLI flow tests in `loopDriver.test.ts` and `serve.loop.test.ts`, and gui tests in `LoopMode.test.tsx`.

### 6.2 What was not built, with a design

- **Progress file (gap 2).** After each item ends, the host appends a block to `.continuous/plans/<slug>.progress.md`: item, status, attempts, the check command and result with the last 20 lines of output, summary, and a "next" line. Harness-written, append-only, never read back into the loop's decisions (the session stays the authority), fed to a fresh session by naming the path in the first message. Anthropic chose JSON over Markdown for the state the model edits; here the model never edits it, so Markdown is fine.
- **Clean state (gap 3).** After a passed check, the host runs `git status --porcelain` and records the paths as `LoopItemState.dirty`; the plan block shows "left uncommitted: ..." for the finished item. Off by default (`loopMode.cleanState`). No commit is made, which keeps the existing decision.
- **Harness handoff (gap 4)** falls out of the progress file: the plan block can show the previous item's check tail.

## 7. Experiments that would settle open points

1. **Fallback on or off,** same plan, same model, n = 10 per arm: rate of items accepted as done that a later test run shows broken. This is the measurement behind decision 1.
2. **Fresh context versus compaction per item,** on a local model, scored by finished items and cost.
3. **Item size,** the same goal split into 4, 8 and 16 items, scored by finished items and total tokens.

## 8. UNVERIFIED

- The Ralph write-ups' failure modes and the 100k-token adherence claim (practitioner posts, no data).
- That OpenAI's Codex recipe includes a commit per milestone (no source required it); its publication date (the page is undated).
- The 16,991-trajectory and 9,374-run studies' details beyond the abstracts the search returned.
- Long-Horizon-Terminal-Bench figures (secondary source).
- Ord's exponential-decay reading of METR time horizons.
- Anything about Devin's plan-execute-verify loop and OpenHands' internal verification.
- Whether Qwen-class models stop early more than other open models.
