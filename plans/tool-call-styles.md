# Tool-call styles per model family

Written 2026-11-09. Roadmap: Track Q in [`ROADMAP.md`](./ROADMAP.md). This file is the handoff: a person or agent who picks up Track Q starts here. It records what was checked against primary sources, what was not, where our code stands, and the spikes that follow. Nothing here is built yet, and no spike has started.

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

## Family matrix: how each family calls a tool

Added 2026-11-09 from a second pass. "Wire" is what the model writes; "Parser" is what a server uses to turn it into the API's `tool_calls`. Sources are the vLLM [tool calling page](https://docs.vllm.ai/en/latest/features/tool_calling/) (its parser table), model-specific parser docs and community parsers; vendor model cards are named where read. A cell marked **unread** was not checked against a primary source and is a hypothesis for P1.

| Family                                 | Wire format the model writes                                                                                                                                                                                                                       | Parser (vLLM name)                            | Notes and cautions                                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Nova, GPT API, Gemini (hosted) | JSON arguments in the provider's own envelope (`tool_use` blocks, `toolUse`, `tool_calls`, `functionCall`). The provider hides the model's raw text                                                                                                | none: the API parses                          | We talk to the envelope, not the model. Differences are in names, edit tool and cache points (Tracks C and Q), not in markup                                                                                                           |
| Qwen3-Coder (and Qwen3-Coder-Next)     | XML: `<tool_call><function=NAME><parameter=KEY>value</parameter></function></tool_call>`; results in `<tool_response>`                                                                                                                             | `qwen3_xml` (the page's name for Qwen3-Coder) | Verified in the template (above). The same XML sits inside `<zyphra_tool_call>` for ZAYA1 and in `<tool_call><function=...>` for Granite 4.2, so the form is spreading                                                                 |
| Qwen3 (non-coder), Qwen2.5, QwQ        | Hermes: `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`                                                                                                                                                                                 | `hermes`                                      | Qwen's guide recommends this form for Qwen3. Which one a Flash or Next-80B checkpoint uses is **unread** (P1)                                                                                                                          |
| GLM-4.5, 4.6, 4.7                      | XML with key and value tags: `<tool_call>NAME` then `<arg_key>k</arg_key>` and `<arg_value>v</arg_value>` pairs                                                                                                                                    | `glm45`, `glm47`                              | Read from community parsers (vLLM, llama.cpp, TabbyAPI), not Zhipu's template. GLM-4.7 puts the pairs on one line; whitespace matters to some parsers                                                                                  |
| DeepSeek V3, R1-0528, V3.1             | Special tokens: a tool-calls block, one call block per tool, name and JSON arguments split by a `tool_sep` token; calls chained with no spaces                                                                                                     | `deepseek_v3`, `deepseek_v31`                 | From the NVIDIA and Replicate model pages. One provider reports an XML form instead, probably its own conversion. Tool calls work in non-thinking mode (V3.1)                                                                          |
| Kimi K2, K2.5, K3                      | Special tokens: `<\|tool_calls_section_begin\|>`, then per call `<\|tool_call_begin\|>functions.NAME:IDX<\|tool_call_argument_begin\|>{json}<\|tool_call_end\|>`                                                                                   | `kimi_k2`                                     | The id `functions.NAME:IDX` is part of the model's habit: a history with ids in another shape makes it invent wrong ones (vLLM's debugging write-up), so normalise ids in history. Source is a mirror of the official guidance; verify |
| gpt-oss (20b, 120b)                    | Harmony: `<\|start\|>assistant<\|channel\|>commentary to=functions.NAME <\|constrain\|>json<\|message\|>{json}<\|call\|>`; result is a message from `functions.NAME` to assistant. Trained on built-in `browser.*` and `python` (analysis channel) | `openai`                                      | OpenAI's page says to "stick to this format closely". Functions are declared as a TypeScript-style `namespace functions` in the developer message. No source found for an `apply_patch` habit in gpt-oss                               |
| Llama 3.1, 3.2, 4                      | JSON `{"name", "parameters"}` (`llama3_json`) or Python-style call lists (`llama4_pythonic`, `pythonic` for 3.2 1B and 3B and Llama 4)                                                                                                             | `llama3_json`, `llama4_pythonic`, `pythonic`  | vLLM recommends `llama4_pythonic` for Llama 4. The `<\|python_tag\|>` built-in-tools form for 3.1 is **unread**                                                                                                                        |
| Mistral, Mixtral, Devstral             | `[TOOL_CALLS]` then JSON (a list before tokenizer v11, the name directly after the token from v11 on); tools in `[AVAILABLE_TOOLS]`, results in `[TOOL_RESULTS]`                                                                                   | `mistral`                                     | The id must be 9 alphanumeric characters or the template raises (vLLM and the Vercel AI SDK issue); we already handle this on Bedrock (`bedrock-mistral-tool-ids`)                                                                     |
| Gemma, FunctionGemma                   | FunctionGemma: `<start_function_call>call:NAME{...}<end_function_call>`; Gemma 3 itself has no native format and is prompted                                                                                                                       | `functiongemma`                               | Gemma 3 pythonic or JSON by prompt is **unread**                                                                                                                                                                                       |
| Olmo 3                                 | Python-style calls in `<function_calls>` tags, one per line                                                                                                                                                                                        | `olmo3`                                       | Shows pythonic calls are a training choice of their own, not only Llama 4                                                                                                                                                              |
| Granite 4.x, InternLM, Jamba, xLAM     | Granite 4.2 XML; xLAM JSON arrays (also in `<think>`, code blocks, `[TOOL_CALLS]`, `<tool_call>`); others **unread**                                                                                                                               | `granite*`, `internlm`, `jamba`, `xlam`       | Listed so the table is complete; none is served on our account today                                                                                                                                                                   |

Four wire shapes cover what was read: **JSON in tags or special tokens** (Hermes, Mistral, DeepSeek, Kimi, Llama 3.x), **XML with named parameters** (Qwen3-Coder, GLM, Granite 4.2, ZAYA), **Python-style calls** (Llama 4, Olmo 3, Llama 3.2 small) and **a routed message** (Harmony). A fifth, **no native form, prompted** (Gemma 3, many small models), is where our own prompt carries the format.

Two facts that matter more than the markup:

1. **The parser is not the model.** A server that runs the wrong parser (or no tool parser) turns a correct call into text. Of the failures seen on 2026-11-08 and 09, P1 must say how many were the model writing the wrong thing and how many were the server not parsing the right one.
2. **Ids and names are part of the habit.** Kimi wants `functions.NAME:IDX`, Mistral nine characters, Claude on Bedrock a fixed pattern. History that carries an id in another shape is a cause of wrong calls, and it is ours to normalise.

## The translation layer

Idea, from the owner: do not force every model to speak one tool language; speak each family's own, and translate at the edge. This is the design the matrix supports. It changes nothing until a spike shows a gain for a family (see Decisions).

Where it sits: between the agent loop (which thinks in our tool schema: names, arguments, results) and the model adapter (which sends and receives text or an API envelope).

```
agent loop  ->  Tool registry (our names and schemas)
                  |
                  v
            ToolDialect for the family  (translate, render, parse, repair)
                  |
                  v
            model adapter / provider API
```

A **ToolDialect** is a small object chosen per model the way `promptProfile` is, with these jobs:

| Job                  | What it does                                                                                                                                                                                                    | Example                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Names**            | Maps our tool names to the family's habit, both ways, so the model sees `edit` and the registry runs `Edit`                                                                                                     | Qwen Code names for Qwen3-Coder, only if P2 measures a win                      |
| **Arguments**        | Reshapes arguments both ways: `old_string` and `new_string` against `old_str` and `new_str`, a path key against a file key, a list against repeated parameters                                                  | Anthropic `str_replace_based_edit_tool` commands against our `Edit` and `Write` |
| **Edit shape**       | Offers the edit form the family does best (exact string, SEARCH/REPLACE block, whole file, V4A patch) and converts it to our edit operation                                                                     | P3 decides per family                                                           |
| **Render**           | When the server does not parse, writes the tool list and the call markup into the system prompt in the family's own form (XML, Hermes JSON, pythonic), so the prompt quotes what the model was trained to write | The tailored Qwen profile already does this for XML (`turns.ts`)                |
| **Parse and repair** | Reads a call the model wrote as text (the `<function=` leak, `present_plan(...)` in Python syntax) and turns it into a call, only when exact and unambiguous                                                    | P5; Nova 2 Lite's Python-style `present_plan`                                   |
| **Ids and history**  | Normalises call ids in history to the shape the family expects                                                                                                                                                  | Kimi `functions.NAME:IDX`, Mistral nine characters                              |
| **Results**          | Renders a tool result the way the family reads one (a `<tool_response>` block, a Harmony message, a plain user turn)                                                                                            | Only when we render the turn ourselves                                          |
| **Capabilities**     | Says what the family cannot do: parallel calls, nested JSON, long arguments, a tool-choice constraint. The loop adapts (one call per turn, flat arguments)                                                      | Small models: flat arguments, one call at a time                                |

Rules for the layer:

- **Translation is lossless or it is not done.** An argument the family cannot express makes the dialect refuse that tool for that family and say so, not drop the field.
- **The registry stays the source of truth.** Policies, protected paths, the command lint and the cache never see a dialect name; they see the registry's.
- **Default is the identity dialect**: today's behaviour. A family moves off it only with a measured win, per the Decisions below.
- **Test with the bench, with the dialect on and off**, n=5 per cell, as P2 and P3 do.

## Leads from another agent's research (not verified)

A second agent compiled the notes below on 2026-11-09 and the owner passed them on as food for thought. They are leads, not findings. The sources are worth reading in P9; the table of "canonical tool names" is not evidence and is kept out of the matrix.

**Sources to read in P9**

- [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools): an archive of extracted prompts and tool definitions of closed agents (Cursor, Windsurf, Claude Code, Devin, Copilot and others). Extracted by third parties, so each prompt needs its date and version checked before it counts as the harness's real text.
- Drew Breunig's write-up on how Claude Code builds its system prompt (blocks added by enabled tools, subagent permissions and budgets). Read it for the structure, and check it against the tool definitions we hold ourselves.
- Cline's `src/core/prompts/system.ts` and Roo Code's modes: how Plan and Act are gated, and Roo's per-mode tool groups (already cited above for mode gating).
- Aider's `aider/coders/` and its edit-format benchmarks, and OpenHands' CodeActAgent templates: the best-documented comparisons of edit formats and tool sets across models.

**Claims in that pass, and what we know**

| Claim                                                                                                                         | State                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models are RL-trained on specific tool names and the harness should match them                                                | The principle is plausible and is what P2 tests. No vendor source lists trained names (see "What is not"), so the specific lists in the claim (`execute_command`, `edit_file`, `search_code` and so on) are unsupported |
| Qwen3 and Qwen3-Coder: Hermes JSON or the `qwen3_coder` XML                                                                   | Matches the matrix. Which form a given checkpoint uses is P1                                                                                                                                                            |
| Claude: `str_replace_based_edit_tool` with `view`, `str_replace`, `create` and `insert`; "trained with `<invoke>` internally" | The tool is documented (above). The `<invoke>` claim has no source here and does not change what we send                                                                                                                |
| OpenAI: `apply_patch` with V4A, strict structured outputs                                                                     | `apply_patch` is documented (above). "Trained on `bash`, `read_file`, `search_files`" is unsourced                                                                                                                      |
| DeepSeek: "JSON in Markdown, or native tool_calls; benefits from `<think>` before a call"                                     | Conflicts with the matrix: the model pages describe special tokens, and one provider reports XML. The `<think>` point is only partly supported (tool calls are documented for V3.1's non-thinking mode)                 |
| Avoid line numbers in edit tools                                                                                              | Consistent with our exact-string Edit and with Aider's and Diff-XYZ's findings that search/replace beats udiff. Keep                                                                                                    |
| Strip write tools in Plan mode instead of telling the model in prose                                                          | Already how our plan turn works (see "Our code today")                                                                                                                                                                  |
| Keep static base and rules first, mode block last, for the cache                                                              | Already how the cache work treats the prompt (Track C: C8, C44, C50)                                                                                                                                                    |
| Mode contract blocks for Plan and Act, a canonical eight-tool schema, `attempt_completion` and `present_plan` as stop signals | Ours exist in other forms (`present_plan`, the turn texts in `turns.ts`); the canonical set is the identity dialect plus aliases, which Q11 builds. Its host is Visual Studio and C#, not ours                          |

The agent's closing question, native JSON tool calls on the wire against parsed inline XML, is answered by the translation layer: native API envelopes for hosted models, the family's own markup (rendered and parsed by the dialect) only where the server does not parse it. Streaming a diff into the editor buffer as it arrives is a separate feature and not part of this track.

## Spikes

Each spike has an exit criterion. A spike that cannot meet its criterion writes that down and stops.

| Spike | Question                                                                                                                                                                                                                                                                                            | Exit criterion                                                                                                                                                                                           | Depends on |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1    | What chat template and parser does each served model actually use? Fetch the Flash and Next-80B templates, and the Strata server's template and parser settings.                                                                                                                                    | A table of family, template markup, parser, and whether our `qwenFormat` matches. Any mismatch is a bug report.                                                                                          | none       |
| P2    | Do our names or Qwen Code's names produce fewer invalid calls on Qwen3-Coder?                                                                                                                                                                                                                       | Bench arms: current names, Qwen Code names with `edit` and `old_string`/`new_string`, Cline-style names. Invalid calls, leaked calls and completion, n=5, per arm.                                       | P1         |
| P3    | Which edit format gives the best completion per family?                                                                                                                                                                                                                                             | Bench arms: exact-string (today), SEARCH/REPLACE blocks, whole-file write. Measure edit failures, retries and completion on a seeded repo.                                                               | P1         |
| P4    | Can Claude use the native text editor on Bedrock, and does it beat our function-tool Edit?                                                                                                                                                                                                          | An adapter route for the Messages format on Bedrock, one scenario, cost and completion against the function tool.                                                                                        | P1         |
| P5    | Is the `<function=` form recoverable when a model writes it as text?                                                                                                                                                                                                                                | A parser in the adapter for the Qwen markup, measured against the H13 nudge. Ship only if it reduces leaks without new false calls.                                                                      | P1         |
| P6    | Does a per-family tool profile help, selected the way `promptProfile` is?                                                                                                                                                                                                                           | A profile table of names, edit format and markup per family, default off, switched on per family only where P2 and P3 measured a win.                                                                    | P2, P3     |
| P7    | Do tool-name typos and description-only reliance change results on our tools?                                                                                                                                                                                                                       | A perturbation set in `bench/`: typos in names, a renamed tool with the same description, a duplicate name. Accuracy per perturbation.                                                                   | P2         |
| P8    | Does an OpenAI-style apply_patch V4A path help any family we serve?                                                                                                                                                                                                                                 | Only if we add an OpenAI family. Decide from P3 first.                                                                                                                                                   | P3         |
| P9    | What does each popular family write natively, and does a server parse it? Complete the family matrix from primary sources (the model's chat template and the vendor's tool-use page): Llama 3.1's built-in form, Gemma 3, Gemini, Nova, GLM and Kimi templates, Granite, and the ones marked unread | The matrix has no unread cell for a family we serve or plan to serve; each row cites a template or a vendor page; the mismatches between a family's wire form and the server's parser setting are listed | none       |
| P10   | Measure the failure split: of the tool-call failures in our bench logs, how many are the model writing the wrong form and how many are the server not parsing the right one?                                                                                                                        | A table by model and run: parsed, leaked as text, wrong form, wrong arguments. The server-side share decides whether P11 is a parser fix or a prompt change                                              | P1         |
| P11   | A `ToolDialect` interface and the identity dialect, with the registry behind it. No behaviour change: today's names, arguments and edit tool pass through it                                                                                                                                        | Every existing tool test passes unchanged; a dialect can be chosen per model in `modeModels` or by model id, default identity                                                                            | P9         |
| P12   | First real dialects, one per wire shape, each measured: XML (Qwen3-Coder), Hermes JSON (Qwen3 non-coder), Python-style (Nova 2 Lite's `present_plan(...)`, Llama 4), with render and parse-and-repair                                                                                               | Each dialect beats the identity dialect on the bench for its family (completion and leaked calls, n=5) or is dropped. A dialect that does not win does not ship                                          | P10, P11   |
| P13   | Ids and history: normalise tool call ids to the family's shape (Kimi `functions.NAME:IDX`, Mistral nine characters) and check history from another family                                                                                                                                           | A model switched mid-conversation keeps calling correctly; a test replays a history from a Claude run into Kimi and Mistral shapes                                                                       | P11        |

## Decisions

- **Speak the family's language; do not teach it ours.** The translation layer is the direction (owner, 2026-11-09). It ships per family and only on a measured win, like names and edit format.

- **Default names and edit format stay as they are** until P2 and P3 report. A name or format change is a per-family change, not a global one.
- **Serve-side parser is the vendor's**, not ours. If P1 finds a mismatch, fix the template or parser setting on the server before changing our markup.
- **No family-specific name list ships** on the strength of a secondary source. Only a measured win in P2 can ship one.

## Pick-up notes

- The bench, its scenarios and the scorer are in `bench/` (Track I). Add scenarios there; do not start a new harness.
- Qwen markup and the tailored profile live in `core/llm/prompts/turns.ts`; tests are in `turns.vitest.ts`.
- Research notes behind this file: `research-qwen-tailoring.md`, `research-qwen-harness.md` and `research-bedrock-families.md` in the session notes folder.
