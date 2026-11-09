# Tool-call styles per model family

Written 2026-11-09. Roadmap: Track P in [`ROADMAP.md`](./ROADMAP.md). This file is the handoff: a person or agent who picks up Track P starts here. It records what was checked against primary sources, what was not, where our code stands, and the spikes that follow. Nothing here is built yet, and no spike has started.

## Start here

1. Read "What is verified" and "What is not" before any design. Several claims that circulate about model training were not supported by any source.
2. Read "Our code today" to see what the tool-call path does for each family.
3. Pick the first spike in "Spikes": P1 (confirm the serving templates) is cheap, changes no behaviour, and decides what P2 and P3 test.
4. Every spike ends in a number from the bench (`bench/`, Track I), not a judgement. The bench already runs `cn serve` per model with invalid-call, leak and completion columns.

## Why this matters

Tool calls fail for a model in two ways: the call never parses, or it parses and the arguments are wrong for the edit. Both appear in our logs. On 2026-11-08 and 2026-11-09 the Qwen3-Coder runs wrote tool calls as plain text in 3 of 6 short plan runs, while the tailored markup brought that to 0 of 6 (`research-qwen-tailoring.md`). Nova 2 Lite wrote `present_plan(...)` in Python syntax instead of calling it. Those are format failures, not reasoning failures, so format is a lever we can measure.

## What is verified

Each line names its source. These were read on 2026-11-09.

**Wire format**

- Qwen3-Coder's chat template renders a tool call as `<tool_call>` wrapping `<function=NAME>` and one `<parameter=KEY>` per argument, and it returns tool results inside `<tool_response>` tags in user turns. Source: the `chat_template` in [Qwen3-Coder-30B-A3B-Instruct tokenizer_config.json](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/tokenizer_config.json).
- Qwen's own function-calling guide recommends Hermes-style JSON for Qwen3 and serves it with `--tool-call-parser hermes`. It also says function calling "is essentially implemented using prompt engineering". Source: [Qwen function calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html).
- Qwen3-Coder's serving parser is `qwen3_coder` in vLLM and SGLang. Source: [SGLang cookbook](https://cookbook.sglang.io/autoregressive/Qwen/Qwen3-Coder), [vLLM qwen3 parser](https://docs.vllm.ai/en/latest/api/vllm/parser/qwen3/).

**Harnesses the vendor names**

- The Qwen3-Coder model card says it is designed for Qwen Code and Cline and "featuring a specially designed function call format". Source: [Qwen3-Coder-30B model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct). This is the only vendor statement about which harnesses the model was built for.

**Tool names in Qwen Code**

- Qwen Code's documented tools include `grep_search`, `edit` (taking `old_string` and `new_string`; a third-party guide adds that it fails when `old_string` is not unique), `write_file`, `run_shell_command`, `todo_write` and `web_fetch`. `read_file` is used in examples but its schema was not confirmed. Source: [Qwen Code file-system tools](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/file-system/), [tools introduction](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/introduction/).

**Anthropic native tools**

- The text editor tool has type `text_editor_20250728` and name `str_replace_based_edit_tool`, with commands `view` (optional `view_range`), `str_replace` (`old_str`, `new_str`), `create` (`file_text`) and `insert` (`insert_line`). It lists Haiku 5.5, Sonnet 5.5 and Opus 5.5 as supported, and Amazon Bedrock as a stable platform. Source: [Anthropic text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool).
- AWS's current tool-use guide says Anthropic-defined tools (computer, bash, text editor, memory) use the Anthropic Messages request format, and that Converse supports custom tools. Older AWS examples showed the text editor through Converse. Source: [Bedrock tool use](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html).

**OpenAI apply_patch**

- The tool type is `apply_patch`. The model returns `create_file`, `update_file` or `delete_file` operations whose diffs use the V4A format, and the developer's harness parses and applies them. Source: [OpenAI apply_patch guide](https://developers.openai.com/api/docs/guides/tools-apply-patch).

**Edit formats**

- In [Diff-XYZ](https://arxiv.org/html/2510.12487v2) (JetBrains, revised 2025-11-17), search/replace beat udiff on diff generation for Claude 4 Sonnet (0.94 against 0.82), GPT-4.1 (0.95 against 0.81), GPT-4o, Gemini 2.5 Flash and Qwen2.5-Coder-32B (0.68 against 0.23). GPT-4.1-nano is the exception, preferring udiff (0.50 against 0.07). On apply, which is closest to our exact-string Edit, search/replace scored 0.92 against 0.84 for Qwen2.5-Coder-32B.
- Qwen2.5-Coder models under 32B scored between 0.00 and 0.28 on diff generation, search/replace best of the formats tested. Format does not rescue a small model.
- [Aider's edit-format docs](https://aider.chat/docs/more/edit-formats.html) describe whole, diff (search/replace), diff-fenced, udiff and editor-diff. They tie udiff to GPT-4 Turbo ("lazy coding") and diff-fenced to Gemini. They make no benchmark claim for whole-file on any family.

**Robustness**

- [RobustBench-TC](https://arxiv.org/abs/2605.11928) (2026) reports that observation perturbations reduce accuracy by under 5%, and reward-relevant and transition perturbations by roughly 40% and 30%. It reports no isolated result for renaming a tool. Its page dates look inconsistent, so check the paper before citing the figures.

**Mode gating**

- Roo Code restricts tools per mode through groups (read, edit, browser, command, mcp) in each mode's `groups` array. Source: [Roo Code modes](https://docs.roocode.com/basic-usage/using-modes).
- Cline's Act mode allows every tool except its plan reply tool. Source: [Cline plan and act](https://docs.cline.bot/exploring-clines-tools/plan-and-act-modes-a-guide-to-effective-ai-development). Sources disagree on the name of the plan reply tool, so verify it in the code before citing.

## What is not

- **Tool names a model was trained on.** No vendor document lists them. The names in circulation (`execute_command`, `edit_file`, `search_files`) were not found in any Qwen source, and the one Qwen example name was a placeholder (`square_the_number`). Treat any family-specific name list as a hypothesis until P2 measures it.
- **Whether a rename alone changes accuracy.** Not isolated in any source we found.
- **The Flash and Next-80B chat templates.** We assume Flash uses the XML form and Next-80B the Hermes form. Neither template was fetched. P1 checks both.
- **Native Anthropic editor through Bedrock Converse.** Current AWS docs point to the Messages format. Whether Converse accepts these tool types was not confirmed.
- **Qwen3-Coder under the edit-format study.** Diff-XYZ tested Qwen2.5-Coder. Its results carry over to Qwen3-Coder only by analogy.
- **Whole-file editing against search/replace for any Qwen model.** Not in any source.

## Our code today

- **Markup.** `qwenFormat` in `core/llm/prompts/turns.ts` picks XML for models matching `coder` or `flash`, and Hermes for other Qwen models. The tailored profile quotes that markup. Consistent with the Qwen3-Coder template; the Flash and Next-80B picks are the unverified part.
- **Names, IDE.** `read_file`, `create_new_file`, `edit_existing_file`, `run_terminal_command`, `grep_search` (`core/tools/builtIn.ts`).
- **Names, CLI.** `Read`, `Write`, `Edit`, `Bash`, `Grep`. The CLI's `Edit` takes `old_string` and `new_string` in exact-string replacement (`extensions/cli/src/tools/edit.ts`), the same semantics as Qwen Code's `edit` and Anthropic's `str_replace`.
- **Edit semantics.** Exact-string replacement everywhere. No SEARCH/REPLACE block, udiff or whole-file mode exists.
- **Adapters.** Bedrock goes through Converse for every family, including Claude, so Anthropic-native tools are not sent.
- **Mode gating.** The plan turn withholds write tools from the tool list; the prose rule is a backup. Consistent with Roo's approach.
- **Recovery.** A tool call written as text ends the turn with no nudge on the Qwen and Nova cases (H13 in Track H).

## Spikes

Each spike has an exit criterion. A spike that cannot meet its criterion writes that down and stops.

| Spike | Question                                                                                                                                                         | Exit criterion                                                                                                                                                     | Depends on |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| P1    | What chat template and parser does each served model actually use? Fetch the Flash and Next-80B templates, and the Strata server's template and parser settings. | A table of family, template markup, parser, and whether our `qwenFormat` matches. Any mismatch is a bug report.                                                    | none       |
| P2    | Do our names or Qwen Code's names produce fewer invalid calls on Qwen3-Coder?                                                                                    | Bench arms: current names, Qwen Code names with `edit` and `old_string`/`new_string`, Cline-style names. Invalid calls, leaked calls and completion, n=5, per arm. | P1         |
| P3    | Which edit format gives the best completion per family?                                                                                                          | Bench arms: exact-string (today), SEARCH/REPLACE blocks, whole-file write. Measure edit failures, retries and completion on a seeded repo.                         | P1         |
| P4    | Can Claude use the native text editor on Bedrock, and does it beat our function-tool Edit?                                                                       | An adapter route for the Messages format on Bedrock, one scenario, cost and completion against the function tool.                                                  | P1         |
| P5    | Is the `<function=` form recoverable when a model writes it as text?                                                                                             | A parser in the adapter for the Qwen markup, measured against the H13 nudge. Ship only if it reduces leaks without new false calls.                                | P1         |
| P6    | Does a per-family tool profile help, selected the way `promptProfile` is?                                                                                        | A profile table of names, edit format and markup per family, default off, switched on per family only where P2 and P3 measured a win.                              | P2, P3     |
| P7    | Do tool-name typos and description-only reliance change results on our tools?                                                                                    | A perturbation set in `bench/`: typos in names, a renamed tool with the same description, a duplicate name. Accuracy per perturbation.                             | P2         |
| P8    | Does an OpenAI-style apply_patch V4A path help any family we serve?                                                                                              | Only if we add an OpenAI family. Decide from P3 first.                                                                                                             | P3         |

## Decisions

- **Default names and edit format stay as they are** until P2 and P3 report. A name or format change is a per-family change, not a global one.
- **Serve-side parser is the vendor's**, not ours. If P1 finds a mismatch, fix the template or parser setting on the server before changing our markup.
- **No family-specific name list ships** on the strength of a secondary source. Only a measured win in P2 can ship one.

## Pick-up notes

- The bench, its scenarios and the scorer are in `bench/` (Track I). Add scenarios there; do not start a new harness.
- Qwen markup and the tailored profile live in `core/llm/prompts/turns.ts`; tests are in `turns.vitest.ts`.
- Research notes behind this file: `research-qwen-tailoring.md`, `research-qwen-harness.md` and `research-bedrock-families.md` in the session notes folder.
