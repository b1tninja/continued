# Stuck detection: calibration, check-in experiment and escalation

Status: research and design, 2026-11-10. Rows S1 to S6 of Track S, T8 of Track T. Nothing here changes a threshold: the one real run we hold does not support it (section 2). What is added with it is the S3 experiment's constants, scorer and fixtures (`core/util/stuckExperiment.ts` with its test, `bench/scenarios/stuck-decoy.json` and its seed).

## 1. Decisions in short

1. **No threshold changes now.** One long recorded session exists, with proxy labels only; a sweep of the two loudest signals did not separate stuck from healthy (section 2.4). Collect labelled runs (section 2.6) first.
2. **Three defects found, to fix before S2 ships a note to a model** (the first two from the session, the third from a fixture, section 2.7: an edit, run, same-failure loop is invisible to all eight signals): `no-progress` treats a terminal command that returns something new as no progress, and the file-change reset only sees the edit tools, never a write made through the shell. The measurement also needs a window: the run must be cut at each user message, the rule OpenHands uses.
3. **S3 is a 2-arm trial** (no check-in, check-in) on a decoy-file scenario, n = 10 per arm per model, pass bar fixed in the code before any run (section 6).
4. **The ladder gains an episode rule and a policy-block branch** (section 7): a signal that the model ignored 70 times in the data cannot be fixed by a sentence, so that class goes straight to enforcement.
5. **A check-in is a user-role message appended at the tail**, never a system message in the middle and never an edit of an earlier message; the cache prefix is untouched (section 8).

## 2. What we measured

### 2.1 What recorded histories exist on this machine

Searched `~/.continuous`, `~/.continue`, `D:\temp` (including the 19 worktrees' `bench/` folders) and the scratchpad.

| Where                                                | What                                                                                                                                                                                                                                             | Usable                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `~/.continuous/sessions/baf47d9e-...json` (309 MB)   | One IDE loop-mode session on `qwen3.8-flash-next-nvfp4` (local, OpenAI-compatible): 1,113 steps, 1,331 tool calls, 48 user turns, 12 `finish_item`, 1,120 requests, 84.3 M prompt tokens of which 77.2 M cached (91.6%), 223 k completion tokens | Yes, unlabelled         |
| `~/.continuous/sessions/wave-sandbox-1.json`         | 14 steps, 21 calls (loop wave sandbox)                                                                                                                                                                                                           | Yes, too short          |
| Nine other session files in the two session folders  | 1 to 3 steps, at most 1 call each                                                                                                                                                                                                                | No                      |
| `D:\temp\continue-cli-test-*\sessions` (7,398 files) | CLI end-to-end test fixtures, mostly byte-identical (the largest is 70 KB)                                                                                                                                                                       | Not loops; not measured |
| `bench/` result folders                              | None. The only `bench/results` found is an unrelated inference-speed benchmark (2026-09 and 2026-10 folders). The Nova, Qwen, Kimi and DeepSeek loop histories the S1 row names are not on this machine                                          | No                      |

So S1 can be answered from one session, not from the planned sample. It is a real overnight run, which is more than the 18-history corpus, and it fails the plan's bar in an informative way.

### 2.2 The run, whole

`measureStuck.ts` as shipped (copied outside the repo, read-only), the session as one run:

| Signal                 | First `note` | First `stuck` | Stuck episodes (a new one each time a signal returns after a gap) |
| ---------------------- | ------------ | ------------- | ----------------------------------------------------------------- |
| repeat-error           | step 12      | step 19       | 85                                                                |
| no-progress            | 22           | 67            | 30                                                                |
| retry-after-fail       | 228          | 728           | 13                                                                |
| near-repeat            | 855          | 859           | 9                                                                 |
| repeat-call            | 397          | 770           | 5                                                                 |
| ping-pong              | 397          | never         | 0                                                                 |
| edit-revert, monologue | never        | never         | 0                                                                 |
| overall                | 12           | 19            | 142                                                               |

Over every prefix, the report was `stuck` in 516 of 1,113 (46%) and `note` in 93 more. There were 54 file changes in 1,331 calls and 4 text-only steps, so edit-revert and monologue had almost nothing to see.

### 2.3 Where it fired, read against the log

- **Steps 1 to 591** (the model reading, planning and building; no sign of a spiral in the work log): `stuck` on 205 of 591 prefixes (35%), all `no-progress` (200) and `repeat-error` (4). Two causes. (a) Steps 62 to 67 are a script written, parsed, run with `--help`, run on data, then two greps: six useful steps with no edit-tool call, so the signal reached `stuck`. 617 of the 1,331 calls are `run_terminal_command`, and the signal counts progress only as a file change, the same call answering differently, a new file read or a new error text; a new successful command output is none of those. The adapter derives a file change from the edit tools' arguments only, so a script that writes a file is invisible too. (b) `repeat-error` reached `stuck` at step 19 on three "file does not exist" results at steps 5, 12 and 19: three different mistyped paths over fourteen steps, not a repeat.
- **Steps 592 to the end**: `stuck` on 311 of 522 prefixes (60%). This is a real spiral and the detector sees it at once (repeat-error `stuck` at step 592 and 597). The agent's calls needed the person's approval; each result said so, "held as question", later "the loop already holds N questions, continue on a state that needs none". The same masked error was returned up to 70 times. A policy block is not a confused model, but the model's behaviour is the point: it was told in the tool result not to retry and retried more than 70 times. A note in a tool result (L1) was already there and did not work on this model. If that spiral had been caught at its onset, about 520 steps, 46% of the run, would have been saved; at an average 75 k prompt tokens a request (84.3 M over 1,120) that is of the order of 39 M prompt tokens, mostly cache reads (an estimate; request sizes were not measured per step).

### 2.4 The run cut at each user message

The loop sends one user message per item and per question, and OpenHands scopes its detector to the events since the last user message. Cut that way there are 48 segments, 30 of at least 8 steps. The report reached `stuck` in 26 of the 30 and `no-progress` alone in 20. Proxy labels (the person's next message: "This item failed", "You ended without reporting", anything else) are weak: "anything else" includes the spiral. Still:

| Segment followed by                | n (at least 8 steps) | overall `stuck` |
| ---------------------------------- | -------------------- | --------------- |
| "This item of the plan ... failed" | 3                    | 3               |
| "You ended without reporting"      | 4                    | 3               |
| anything else                      | 23                   | 20              |

A sweep (scratch script, thresholds changed in memory only) of the stuck level of `no-progress` from 6 to 20 and `repeat-error` from 3 to 5:

| Setting                           | failed | no report | other |
| --------------------------------- | ------ | --------- | ----- |
| as shipped                        | 3/3    | 3/4       | 20/23 |
| no-progress 10                    | 3/3    | 3/4       | 17/23 |
| no-progress 12                    | 2/3    | 3/4       | 16/23 |
| no-progress 20                    | 2/3    | 1/4       | 14/23 |
| no-progress 12 and repeat-error 5 | 2/3    | 3/4       | 12/23 |

No setting reaches the plan's 5% on the "other" column while keeping the failed segments. Raising a number only trades recall for fewer false alarms at a constant poor ratio, so the defect is in what counts as progress, not in the number. That is why this document recommends no threshold edit. Caveat: n = 1 run, one model, labels from a proxy.

### 2.5 Thresholds: keep, and what to test

| Signal           | Shipped note / stuck | Evidence                                                                                                                                                          | Recommendation                                                                                                                                           |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repeat-call      | 3 / 4                | OpenHands 4 for same action and observation (docs, 2026-11-10); Koda and Gemini-CLI-derived guards use 5 consecutive. Data: 5 episodes, all of them in the spiral | Keep                                                                                                                                                     |
| near-repeat      | 3 / 4                | 9 episodes, all after step 592 (repeated PowerShell probes)                                                                                                       | Keep                                                                                                                                                     |
| repeat-error     | 2 / 3                | OpenHands 3. Data: 85 episodes, 81 in the spiral, 4 before it, 1 of them a false alarm (step 19)                                                                  | Keep the numbers; count a failure only if it is the same masked error and no more than 6 steps lie between consecutive ones, and pre-test it on this run |
| retry-after-fail | 3 / 4                | 13 episodes, all in the spiral or in a genuine retry run                                                                                                          | Keep                                                                                                                                                     |
| ping-pong        | 2 / 3 cycles         | OpenHands pings at 6 events; one `note`, no `stuck`                                                                                                               | Keep; no data                                                                                                                                            |
| edit-revert      | 1 / 2                | 54 changes, none reverted in the data; shell writes are invisible to it                                                                                           | Keep; fix the shell-write blind spot first                                                                                                               |
| monologue        | 2 / 3                | 4 text-only steps in the run                                                                                                                                      | Keep; no data                                                                                                                                            |
| no-progress      | 4 / 6                | Measured: fires on 67% of segments of 8 steps or more and on 35% of the healthy phase                                                                             | Do not use for any message until redefined (below); then re-measure                                                                                      |

The redefinition to test: progress is any call whose observation has not been seen in the segment (a hash of the result), as well as the four existing kinds, and a shell command counts as a possible write (a `git status` or file-hash probe at the end of each shell call is cheap, or take the file list from `git diff --name-only` when a command ran). Both are changes to the S0 code and need labelled data; they are not made here.

### 2.6 Data to collect, if more is wanted

For S1 to meet the plan's bar it needs, per model, at least 20 healthy and 10 stuck runs. Collect them this way: run the bench's loop scenarios (`loop-basic`, `loop-fix-forward`, and `stuck-decoy` from section 6) through `bench/runner.mjs` with the `state.json` kept (the runner writes the final `/state`, whose `history` the script reads); add a `labels.json` mapping each result folder to `healthy` or `stuck` by a rule fixed in advance (stuck: the scenario's check never passed and the run used more than 80% of its request budget); add `--segment-by-user` to `measureStuck.ts` so a loop session counts per item. The overnight sessions in `~/.continuous/sessions` are the cheapest healthy-and-stuck mix: label by hand from the work log, 20 minutes a session. Report fire rate, lead time and healthy false positives per signal, as `formatMeasurement` already does.

### 2.7 A blind spot found with a fixture, not the data

The commonest way a coding agent is stuck is: edit, run the test, the same failure, edit again. The scripted decoy history (the S3 scenario, section 6) does exactly that, 8 distinct edits to one file each followed by the same failing `npm test`. `detectStuck` reports `none` throughout: every signal about repeats counts only since the last file change, so each edit resets it, `ping-pong` keys include the changed hash, and no file returns to an earlier hash. This is the "Non-Progressive Iteration" of the taxonomy in section 4, the largest failure class in that study, and the eight signals do not see it. `persistentFailure` in `stuckExperiment.ts` (same masked error from the same program, 3 or more times across at least 2 edits) catches it at the third failure. It is not added to `stuckSignals.ts`: its false-positive rate is unmeasured (the error mask turns numbers into `#`, so "expected 5, got 4" and "expected 5, got 3" count as one error even when the edits are moving toward a fix). The experiment uses it as its trigger; whether it joins the signals is a row for S1 once labelled runs exist.

## 3. What others do

Read on 2026-11-10. Where only a secondary source was found it is said.

| Project                   | Detection and response                                                                                                                                                                                                                                                                                                                                  | Source                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OpenHands                 | Five patterns since the last user message: same action and observation 4 or more times, same action erroring 3 or more, monologue of 3 or more, ping-pong, repeated context-window errors. On detection the conversation is flagged stuck and can be halted; the thresholds are not configurable; on by default                                         | https://docs.openhands.dev/sdk/guides/agent-stuck-detector                                                           |
| Koda (Rust)               | Same call, fingerprint of tool plus the first 200 characters of arguments, 5 times consecutively: first detection injects feedback, the second after a reset is a hard stop; a hard cap of 200 iterations the person can extend                                                                                                                         | https://docs.rs/koda-core/0.3.2/src/koda_core/loop_guard.rs.html                                                     |
| Gemini CLI                | A loop detection service with identical-call and, since 2026-03, an LLM-based check tuned to reduce false positives (PR text, secondary); a Gemini-CLI-derived guard documents 5 as the call threshold (unverified against the official repo)                                                                                                           | https://github.com/google-gemini/gemini-cli/pull/20701                                                               |
| Roo Code (Cline fork)     | One `consecutiveMistakeLimit` governs errors and repetition, 0 means unlimited; replaced a hard-coded 3                                                                                                                                                                                                                                                 | https://github.com/RooCodeInc/Roo-Code/pull/5752                                                                     |
| Aider                     | Lint and test failures are fed back as a reflected message at most 3 rounds, then control returns to the person (secondary write-up, not Aider's docs)                                                                                                                                                                                                  | https://0bserver07.github.io/chimera/field-guide/aider/                                                              |
| mini-swe-agent, SWE-agent | Step and cost limits only (mini-swe-agent defaults 100 steps and 1.0 USD, from a wrapper's docs, not upstream: https://www.mintlify.com/cooperbench/CooperBench/cli/agent-config); in SWE-smith's analysis most failed instances of a 32B agent end by the cost or turn limit, and repetition is measured as the longest run of identical base commands | https://arxiv.org/pdf/2504.21798                                                                                     |
| Claude Code, Codex CLI    | No official loop detector found; a third-party project asserts neither has one (unverified). A feature request exists for Claude Code                                                                                                                                                                                                                   | https://claudeissues.com/issue/4317-feature-request-implement-agentic-loop-detection-service-to-prevent-repetitive-a |

Shape: identical-call counting with a threshold of 3 to 5, scoped to a turn, tell then stop. None of the sources publishes a false-positive rate. Ours is therefore the first figure in this table, from one run.

## 4. Failure taxonomies and the scale of the problem

- **Issue-solving agents.** A taxonomy of 342 failures across 150 issues (https://arxiv.org/html/2509.13941v1) puts 49.1% of OpenHands failures and 51.7% of Claude-tool failures in "Iteration and Validation", which has Non-Progressive Iteration (near-identical patches with cosmetic changes), Blind Strategy Switching, Validation Retreat (editing the test to fit the patch) and Context Amnesia. For OpenHands 80% of failures need 54 rounds against 25 for 80% of successes; failed issues take about 3.5 times the steps. This supports both a step-count signal and the kinds in our list; it also names two our signals do not see: validation retreat and blind switching.
- Failed trajectories are longer and more variable across OpenHands, SWE-agent and Prometheus (https://arxiv.org/abs/2511.00197); the authors say agents need to abandon unproductive loops early instead of hitting a predefined limit.
- **Multi-agent systems.** MAST has 14 modes in three groups (specification, inter-agent misalignment, task verification and termination), built on 150 traces then 1,000+ with kappa 0.88 (https://arxiv.org/html/2503.13657v3). Its "premature termination" and "incomplete verification" are the opposite failures to a loop, which matters for L3: a stop rule that is too eager manufactures them.
- A step-by-step planning agent repeats failing tool calls more than a full-horizon one when tools are unreliable (https://arxiv.org/pdf/2605.08477), and tool-call count is negatively correlated with success (r = -0.18) in SciAgentGym (https://arxiv.org/pdf/2602.12984). Both are weak, indirect support for a no-progress signal.

## 5. Do check-ins unstick models, and small models

- **No study tests our treatment.** The nearest findings pull in different directions. A model told to revise its own reasoning without external feedback does not improve and can get worse (https://arxiv.org/html/2310.01798v1). A supervisor agent that consults and reviews fixed 24 of 108 issues OpenHands had failed, 22.2%, against 7 for a single-agent rerun with a stronger model (https://arxiv.org/html/2509.13941v1; both agents were Claude 3.5 Sonnet, the baseline Claude 4 Sonnet, previously failed issues only). The reading consistent with both: a nudge helps when it brings information the model does not have (a log of what was tried, what changed, a different method), not when it only says "you are stuck".
- Our own data is one point on the negative side: a tool result that said not to retry was ignored 70+ times by a local MoE model.
- **Small and open models.** No controlled comparison of looping by model size was found. Practitioner notes say sub-3B models loop with greedy decoding and no output cap (https://glama.ai/mcp/servers/@orneryd/Mimir/blob/01c0203d447ab4f6e04aa15d0c830d92bd4f2749/docs/research/SMALL_LLM_ANTI_LOOP_STRATEGIES.md, Nov 2025), and forum reports describe small dense models repeating a failing call where a 35B-A3B MoE rarely does (anecdotal). Our run's model is a MoE and was the spiral's actor. Treat model size as a covariate, not a conclusion; S3 runs two models for that reason.

## 6. The S3 experiment, fixed in advance

**Scenario `stuck-decoy`** (`bench/scenarios/stuck-decoy.json`, seed `bench/seed/stuckdecoy`). A package whose failing test reads a value from `src/settings.js`; a stale `src/config.js` of the same shape sits beside it and the README and error text name `config`. The obvious edit, to `config.js`, changes nothing, and the test fails with the same message every time. Recovery is finding which module the code imports (the checks: `npm test` exits 0, and the test file is unchanged). Deterministic: no network, no clock. The treatment arm triggers on `experimentReport` (the shipped signals plus `persistentFailure`, section 2.7), because the shipped signals alone never fire on this scenario.

**Arms.** A: no check-in. B: at the first `stuck` report, one user-role message with the last 12 lines of the work log and the guidance line for the signal (`buildCheckIn`, the plan's table), at most once per episode, re-armed after 5 steps without a signal. Same model, same seed list, same budget (40 requests, 400 k tokens), arms interleaved.

**n.** 10 runs per arm per model, two models (one local, one hosted): 40 runs. The plan said 5; at 5 per arm the smallest detectable lift is 4 of 5 against 0 of 5, which is not a measurement.

**Primary metric.** Recovery: the scenario's check passes within the budget.
**Secondary.** Steps and tokens from first `stuck` to recovery or the end; total tokens; cost; whether the model quoted the log (judged by the file touched, not the text).
**Control.** The healthy scenarios `agent-acts` and `loop-basic`, 10 runs each under B: the check-in must fire on at most 5% of them (the plan's bar), counted by `detectStuck` on the recorded history.

**Pass bar (constants in `stuckExperiment.ts`; changing them after a run is a new experiment):**

1. Arm A's recovery rate is between 0.1 and 0.7, or the scenario is a floor or ceiling and the run says so instead of a verdict.
2. B beats A by at least 0.30 absolute in recovery, one-sided Fisher exact p at most 0.10 (8/10 against 3/10 gives p of about 0.035; 7/10 against 4/10 does not pass).
3. Median tokens of B at most 1.25 times A's.
4. The healthy-control fire rate at most 5% (at n = 20, that is one run).
5. Per model: both models must show a non-negative lift; one model carries nothing.

A pass means "keep L2 on in loops and headless runs". A failure leaves L1 and L3 and turns L2 into the chip only. Neither says anything about interactive use.

## 7. The ladder, refined

| Level | Trigger                                                                         | Action                                                                                                                                                                                         | Rule added                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0    | any signal                                                                      | Work log only, no message                                                                                                                                                                      | The log is always on; it is free                                                                                                                                                                                        |
| L1    | a signal at `note`                                                              | One line in the tool result that tripped it                                                                                                                                                    | Never for `no-progress` until redefined (section 2.5); only once per episode                                                                                                                                            |
| L2    | `stuck`, or two notes                                                           | The check-in, user-role, tail of the request                                                                                                                                                   | Per episode, not per step: 142 `stuck` episodes in the run would otherwise be 142 messages. Cooldown of 5 steps. The text carries information the model lacks: the log, the files unchanged, the error repeated N times |
| L3    | L2 ignored (the next 5 steps still at `stuck`), or a **policy-block** signature | Enforce, then escalate: refuse further calls of that masked family with one result that says what is open; in a loop hold the item (H11); then run the next attempt on the `replan` model (M3) | A policy block (a result that says the call is held or refused) skips L2: the data shows the sentence was already given and ignored 70 times                                                                            |
| L4    | L3 did not change the signal                                                    | Stop and report: the log, the signals, what the person could try; headless it is the end-of-run report                                                                                         | Hard stop only after L2 or L3 was ignored (the Koda rule); never on a single `repeat-call` below the existing limit                                                                                                     |

In the IDE interactive chat the ladder stops at the chip (D3). The guidance table is unchanged from the plan.

## 8. Interplay with budgets (T8) and the cache

- **T8 Review.** The reviewer needs progress evidence; the stuck report plus the work log is it. Proposed rule for the extension from the reserve: extend once if no signal is at `stuck` and a file changed in the last third of the item's steps; otherwise do not extend and split, hold or skip. Pending the redefinition of `no-progress`, "file changed" must come from the disk, not from the edit tools.
- **Spend while stuck.** The spiral cost about 46% of the run's requests. A check-in that arrives at the first `stuck` report instead of the item's limit moves the saving from "stop at the limit" to "stop at the onset". Budget enforcement stays the backstop: stuck detection never raises a limit.
- **Cache.** L1 is appended to a tool result and L2 to the tail, so the prefix is unchanged. Our run read 91.6% of its prompt from cache, so a check-in's cost is the log lines (12 lines, a few hundred tokens), not a second pass over the context. A system-role message in the middle of the history is rejected by some chat templates (Qwen's requires the system message first); use a user role. Never rewrite an earlier tool result after the fact: that invalidates the prefix from that point.

## 9. Risks

- **Check-in as a false alarm.** At 35% healthy-phase `stuck`, an unfixed `no-progress` would interrupt good work. This is the first risk and the reason for the redefinition.
- **Verification is not stuck.** Re-running a test after each edit is the loop. Resetting on shell writes needs the write detection of section 2.5.
- **Compliance gap.** The nudge may be ignored as it was; hence L3 enforces.
- **Premature stop** (MAST's termination modes): L4 only after two ignored steps.
- **Gaming.** A model that reads its own log may vary calls trivially to evade `near-repeat`; `no-progress` is the backstop and again must be right.
- **Measurement.** One run, one model, proxy labels. The numbers in section 2 are a first signal, not a calibration.

## 10. Unverified

- OpenHands source thresholds (only docs read; the docs say ping-pong at 6 cycles, older code used a six-step window).
- Gemini CLI, Aider, mini-swe-agent, Roo and Koda behaviour comes from mirrors, PRs, wrappers or docs.rs, not each project's current source.
- That Claude Code and Codex lack loop detection.
- Whether the spiral after step 592 would have ended by itself; the session's later segments continue, and the end cause was not read.
- The 39 M prompt-token estimate for the spiral (the average per request, not per step).
- Anything about small versus frontier looping rates.
- Whether a check-in helps this repository's models at all: that is S3.
