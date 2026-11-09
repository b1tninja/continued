# Turn-prompt evaluation

Date: 2026-11-08. Code: `core/llm/prompts/evaluation/`, `npm run eval:turns` in `core` (#361). Docs: the "Evaluation" subsection of `modeModels` in `docs/reference.mdx`.

## 1. What it is for

The act and plan turn texts (`core/llm/prompts/turns.ts`) come in two sizes, `full` and `short`, picked per model. A prompt edit that makes a small model stop calling tools, write the plan as text instead of calling `present_plan`, decide a choice the person reserved, or keep a task list while planning was caught only by hand. The reviewer has had an eval with a fixed bar since #152; the turn texts had none.

This eval is the cheapest tier of the model benchmark (`model-benchmark.md`): one request per scenario and profile, ten requests a run, under a cent on Nova 2 Lite, seconds to run. It is not the battery. It fixes the conversation up to the reply that matters and scores that one reply, so it measures the prompt text's effect and nothing else: no seed repository, no `cn serve`, no tool execution. The battery measures whole tasks through the CLI, with everything that surrounds the prompt.

## 2. Scenarios and bar

| Scenario             | A good reply                                                                           |
| -------------------- | -------------------------------------------------------------------------------------- |
| act-calls-tool       | calls a tool rather than describing the step or asking to proceed                      |
| act-after-refusal    | does the next part; does not retry the refused `npm test` or run the tests another way |
| plan-presents        | calls `present_plan`; does not ask "is this plan all right"                            |
| plan-reserved-choice | puts the reserved format choice in `decisions`; neither plan nor to-do decides it      |
| plan-no-task-list    | calls `present_plan` and never `task_list`                                             |

A plan conversation already contains the research: every seed file read, every directory listed. If the model still replies with reads, the runner answers them from a fixed copy of the seed for up to three rounds and scores the first reply that is not a read; the rounds are a column in the report.

The bar, fixed before the first run (`qualityBar.ts`), applies to each profile: no reserved choice decided or dropped, `present_plan` in at least 90% of plan scenarios, a tool call in at least 90% of act scenarios, no refused call retried or routed around, median latency per reply at most 10 s. `--stub oracle` meets it; `--stub text-only` fails it; both are vitest cases, so the harness is checked in CI without a model.

Not part of the bar, shown as a note: a `present_plan` call with more than 400 characters of text beside it (the plan written twice, against the turn text's "do not repeat the plan after the call"). Also counted and shown, not in the bar: replies cut off at the output budget (4,000 tokens, the benchmark's default for a small model); a cut-off reply's text is not scored as an answer.

Plan scenarios offer what Plan mode offers: the read-only tools and `present_plan`, no `task_list`. The first runs offered `task_list` too, and that is where the Nova and Qwen task-list failures below came from (section 4).

## 3. Nova 2 Lite, 2026-11-08

Bedrock `us.amazon.nova-2-lite-v1:0`, us-east-1, through core's Bedrock provider (`--provider bedrock`), temperature 0, two runs, 20 requests, under two cents. Reports and reply dumps are in the session notes folder (`nova2lite-run1.md`, `nova2lite-run2.md`, and the `.json` dumps).

| Scenario             | full, run 1                                                       | full, run 2     | short, run 1                   | short, run 2                    |
| -------------------- | ----------------------------------------------------------------- | --------------- | ------------------------------ | ------------------------------- |
| act-calls-tool       | read_file                                                         | read_file       | read_file                      | read_file                       |
| act-after-refusal    | create_new_file                                                   | create_new_file | create_new_file                | create_new_file                 |
| plan-presents        | present_plan                                                      | present_plan    | text only                      | present_plan                    |
| plan-reserved-choice | present_plan, decided "readable" as an assumption, no `decisions` | same            | task_list                      | task_list                       |
| plan-no-task-list    | present_plan                                                      | present_plan    | text only                      | present_plan                    |
| Median latency       | 4.2 s                                                             | 2.9 s           | 0.8 s                          | 1.0 s                           |
| Meets the bar        | no (reserved)                                                     | no (reserved)   | no (reserved, present_plan 0%) | no (reserved, present_plan 67%) |

What the runs show:

1. **Both act scenarios pass under both texts, four of four.** The act-turn failures seen by hand on Nova (listing steps, stopping) did not reproduce on a first reply; if they exist they are mid-task, after tool results, which these fixtures do not reach (section 4, item 3).
2. **The full plan turn decides the reserved choice, both runs.** The plan says "The function will return a readable date format" and records it under Assumptions, with no `decisions` entry: the Mistral Large 3 pattern from `research-plan-ask-models.md` (follow the assume fallback to the letter). The short text puts the reserved-choice rule before the assume fallback; the full text has it after. The Qwen note found the same order fix stopped Qwen3-Coder deciding reserved choices.
3. **The short plan turn loses `present_plan` on Nova.** Two of six short plan replies were text only and two called `task_list` (both on the reserved-choice scenario, both runs). Short was measured on Qwen only; on Nova it is worse than full. `promptProfile` stays `full` for Nova, and K1's per-family measurement is confirmed necessary rather than assumed.
4. **Every presenting reply writes the plan in text as well.** Ten of ten `present_plan` calls came with 950 to 3,100 characters of the same plan in the text content. The IDE shows both. This is output cost and a duplicate on screen, not a correctness failure, so it is a note today.
5. **Variance at n=1 is real.** The short profile's plan-presents and plan-no-task-list flipped between runs at temperature 0. One run says little; the bar should be read over three.

## 4. K8, same day: what moved the numbers and what did not

Three changes were tried against the section 3 result, each measured with the eval (reports under `k8/` in the session notes folder: `before`, `after`, `notasklist`, `final`).

1. **Wording in the plan turns: no effect, reverted.** The full text already has the reserved-choice rule before the assume fallback, so the "reorder" premise was wrong. Naming the cues ("that is my call", "I have not decided"), saying that writing the pick down as an assumption is not an option, saying the to-dos go in the `present_plan` call and never in `task_list`, and restating the rule at the finish changed nothing: Nova still wrote "return a readable" as an assumption under both texts, Qwen3-Coder-30B still called `task_list` in four of six plan replies, Haiku 4.5 still met the bar. The edit was reverted; the text that ships is the text that was measured.
2. **Withholding `task_list` in Plan mode: fixed Qwen.** The CLI already did this (`extensions/cli/src/tools/index.tsx`, from `research-bedrock-families.md` item 3); the GUI still offered it. With the GUI matching the CLI (`gui/src/redux/selectors/selectActiveTools.ts`) and the eval offering Plan mode's real tool set, Qwen3-Coder-30B went from `present_plan` in two of six plan replies to six of six under the full text in two runs, with the reserved choice in `decisions` both times; under the short text it met the bar in one run and decided the reserved choice as an assumption in the other. Qwen takes three rounds of reads before it presents.
3. **A larger output budget and stop reasons: uncovered Nova's real failure.** With `task_list` gone, Nova 2 Lite's plan replies after two rounds of reads became deliberation in plain text ("Okay, let's see. The user wants..."): 6,500 characters at a 1,500-token budget, 17,000 at 4,000, cut off at `max_tokens` or ended with no call. Core sends Nova 2 no `reasoningConfig` unless reasoning is switched on (`bedrockReasoningFields`), so the model reasons in its content. This is not a prompt-text failure and the eval now reports it as a cut-off reply rather than "text only". It belongs to K2: probe `reasoningConfig: { type: "disabled" }` for Nova 2, and the redacted-reasoning path, before any more prompt work on Nova.

4. **K2 probe: reasoning on cures Nova.** `novaReasoning.live.vitest.ts` (opt-in, `RUN_BEDROCK_LIVE=1`) sends the reserved-choice conversation straight to Bedrock Converse under three settings, two runs each, 4,000 max tokens, full text:

   | Setting                                                           | Read rounds | Final text chars | Reasoning blocks   | Final call           | Stop reason                    |
   | ----------------------------------------------------------------- | ----------- | ---------------- | ------------------ | -------------------- | ------------------------------ |
   | no `reasoningConfig` (what core sends today)                      | 2, 2        | 11,785; 11,197   | none               | none                 | `malformed_model_output`, both |
   | `reasoningConfig: { type: "disabled" }`                           | 2, 2        | 17,463; 17,773   | none               | none                 | `max_tokens`, both             |
   | `reasoningConfig: { type: "enabled", maxReasoningEffort: "low" }` | 0, 0        | 0; 0             | one redacted block | `present_plan`, both | `tool_use`, both               |

   So `disabled` is not the cure; it makes the deliberation longer. With reasoning on at low effort the model does its thinking in the (redacted) reasoning block, needs no further reads and presents at once. The eval gained `--reasoning low|medium|high` (sent through core's own `reasoning` and `reasoningBudgetTokens`, so Bedrock gets `bedrockReasoningFields`' switch) and Nova 2 Lite was run twice at low under both texts (`k2/` in the session notes): **full text meets the bar in two of two runs**, with no plan repeated in text and no reads; short text meets it in one of two (one plan-presents reply was text only). Act scenarios four of four.

   The recommendation for K2 therefore inverts its row as written, and it is built in the same PR: `bedrockReasoningFields` (both copies, core and the CLI adapter) now sends `reasoningConfig` at `low` for a `nova-2-` model when the config says nothing about reasoning; `reasoning: false` (`reasoningEffort: off`) still sends nothing, and an explicit effort still wins. Two runs of the eval with no flag, so the default is what is measured (`k2-default/` in the session notes): run 1 met the bar under both texts; run 2 missed it under both, each on one plan reply that wrote the `present_plan` call as text in Python syntax (`present_plan(title=..., decisions=[...])`, with the reserved choice correctly inside it) instead of making the call. The eval now names that shape ("a tool call written as text, not made") rather than "text only". Over the four runs at low effort (two with `--reasoning low`, two with the default), the full text met the bar in three and the short text in two.

   Nova 2 Lite's remaining failure at low effort is therefore the call written as text, a tool-calling failure the bench's compliance scenarios also watch for, not a prompt-text failure and not the deliberation.

Haiku 4.5 met the bar under both texts in every run, so the bar is attainable and the scenarios are not impossible. After K8 and the K2 probe the results stand at: Haiku 4.5 meets the bar (both texts); Qwen3-Coder-30B meets it under the full text (two of two runs) and under the short text in one of two; Nova 2 Lite meets it under the full text with reasoning at low (two of two) and does not with reasoning off.

## 5. Follow-ups, in order

1. **Nova 2 tool calls written as text.** With reasoning on by default (done, section 4, item 4), what is left on Nova 2 Lite is a `present_plan` call written out in Python syntax in one reply of six, twice. Decide whether the Bedrock path should parse that shape back into a call (as the CLI's nudge and the bench's "text leaks" count treat Qwen's markup), or whether the turn text says "call the tool, do not write the call"; measure either with the eval.
2. **`--runs N` and pass counts per cell.** Report "2/3" per scenario and profile; the bar lines become rates over runs. Three runs of ten requests on Nova is still under a cent.
3. **Mid-task act fixtures.** A conversation that is several tool rounds in, where the next step is decided and the failure is to summarise and stop ("Plan, then build is not a stopping point"); an act turn with a task list shown that must call `task_list`; a plan turn asked to "do the work" that must plan, not edit; a Loop item turn that must end with `finish_item`.
4. **Go through core's provider classes for every provider**, as the Bedrock adapter does, so the request is built the way the IDE builds it (tool conversion, caching fields, family quirks) and the eval measures the real request. The hand-written OpenAI-compatible and Anthropic adapters are then only for servers core has no class for.
5. **Share the adapters with the reviewer eval** (`core/tools/permissions/auto/evaluation/adapters.ts`): the reviewer bar (B4) has never been measured on a real model; with the Bedrock adapter it is a one-line run on Nova 2 Lite.
6. **The canonical refusal result.** `act-after-refusal` hand-writes the tool result a refused call gets. Core should export that text (the `decide.ts` reason plus "do not retry it or reach the same result another way") and the GUI, the CLI and the fixture use the one string.
7. **Plan-repeated-in-text**: decide whether the IDE collapses text that accompanies a `present_plan` call, or the turn text's line gets stronger, then promote the note to a bar line.
8. **Usage and cost columns** from the adapters' usage fields, so the report shows what each profile costs on a model (the short text is cheaper per request and worse on Nova; the trade is only visible with both numbers).
9. **A nightly run on Nova 2 Lite** from CI (OIDC to the test account), with the report posted as a check summary, so a prompt edit that regresses a cheap model is seen the next morning.
