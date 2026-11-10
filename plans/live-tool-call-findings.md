# Live tool-call findings (Bedrock Converse, 2026-11-10)

Real replies from our own runs replace the synthesised fixtures where they can. Eight tool-expected prompts per model (read, run, a two-call prompt, write, search, git, config); the captures were non-streaming `Converse` requests at temperature 0 with two tools declared (`read_file`, `run_command`). The first observed fixtures of the corpus come from them (`core/llm/toolDialects/corpus/fixtures/*-bedrock-*.json`, provenance `Observed live on Bedrock Converse 2026-11-10, model <id>`).

## Measured

| Model (id as sent)                                                                                                                                                                                          | Expected style                | Structured toolUse | Text leak (tool markup in visible text)                           | Recoverable by this change                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Llama 3.3 70B                                                                                                                                                                                               | JSON `{type,name,parameters}` | 0/8 (0%)           | 8/8 (100%)                                                        | 6/8 (`llama-json`); 2/8 carry `"timeout": "10"` for an integer    |
| Llama 4 Maverick                                                                                                                                                                                            | JSON / pythonic               | 6/8 (75%)          | 2/8 (25%)                                                         | 0/2: every argument wrapped as `{"type":"string","value":...}`    |
| DeepSeek V3.2 (`deepseek.v3.2`)                                                                                                                                                                             | DSML                          | 8/8 (100%)         | 8/8 end the text with `<｜DSML｜function_calls`                   | fragment now always dropped (the call is the structured one)      |
| Kimi K2 Thinking                                                                                                                                                                                            | `functions.name:idx`          | 8/8 (100%)         | 0/8 on tool turns; 1 `<think>..</think>` block on the replay turn | block lifted into reasoning                                       |
| Qwen3-Coder 30B                                                                                                                                                                                             | `<function=...>` XML          | 7/8 (88%)          | 1/8 (prompt 7)                                                    | 1/1 by `qwen-xml` (already in main); verified against the capture |
| Gemma 3 27B                                                                                                                                                                                                 | none (no native tools)        | 0/8 (0%)           | 0/8 (prose, code, refusals)                                       | not recoverable; see below                                        |
| Nova Pro/2 Lite, GLM 4.7/5, Devstral 2, Mistral Large 3, Kimi K2.5/K3/K3.1, MiniMax M2/M2.5, Nemotron 3 Super / Nano 3, Qwen3 32B, Qwen3-Coder Next, gpt-oss 20B/120B, Strata Qwen3.8 Flash, Ollama Qwen3.6 | structured                    | 100%               | 0%                                                                | nothing to do                                                     |

Note the text-leak rate counts only replies carrying tool markup. Llama 3.3 returned `stopReason: end_turn`, so nothing signalled a call to the handler.

Texts as returned: Llama 3.3, `{"type": "function", "name": "read_file", "parameters": {"path": "src/main.ts"}}`; for two calls a JSON array of JSON-encoded strings (`["{\"type\": ...}", "{...}"]`); Llama 4 Maverick twice such an array whose arguments are schema-shaped objects.

## What was found and fixed

1. **DSML fragment.** The marker is exactly `<｜DSML｜function_calls` (U+FF5C), which is the constant already in the repo, so the full-width handling was right. The leak was a path gap: the hold-back existed only in the streaming handlers. `_converseWholeMessage` (core) and `converseWholeMessage` (adapters) yielded the text block unfiltered, and in core the streaming branch that feeds an active recovery stage skipped the hold-back too. The captures were non-streaming. DeepSeek V3.2 itself is not routed through Converse unless ConverseStream refuses its tools, so the streaming path is the one users normally hit; it holds back the marker and was covered, but there is no streamed capture to prove the exact delta boundaries. Now: one `cleanReplyText` for whole replies, the hold-back before recovery in core, and the hold-back keys on `<｜DSML｜` or `<|DSML|` rather than on one tag name, so `invoke` or `tool_calls` fragments are dropped too. Always on.
2. **`<think>` leak.** Kimi K2 Thinking wrote `<think> ... </think> answer` into the text of a reply to a tool result even though it had sent `reasoningContent` earlier. The Nova `<thinking>` splitter is now parameterised by tag pair, applied to ids containing `kimi-k2-thinking`, and used on whole replies as well as streams. Always on for those models.
3. **Llama JSON.** New `llama-json` recovery, off unless `CONTINUE_RECOVER_TEXT_TOOL_CALLS=llama-json` (or the request field). Strict: the whole reply is one call object, or an array of call objects or of JSON-encoded strings of them; keys exactly `name`, `parameters` and an optional `type: "function"`; declared tool; schema-typed arguments (a numeric string for an integer is refused); required arguments present; model id contains `llama`.
4. **Qwen XML as text.** The capture is prose, a `<function=run_command>` block, then a stray `</tool_call>` with no opener. `qwen-xml` recovers it exactly (fixture `qwen3-coder-30b-bedrock-function-xml-as-text` passes under every chunking).

## Gaps this does not close

- Llama 3.3 has tools switched off in `core/llm/toolSupport.ts` (`bedrock`), so no tools reach it today and recovery has nothing to do until they are enabled with `capabilities.tools`. The 2026-11-08 note that it "calls tools only outside streaming" does not hold for non-streaming either (0/8 structured on 2026-11-10).
- Two of the eight Llama 3.3 replies are refused by strict typing (`"timeout": "10"`). Coercing a numeric string to an integer is lossless and could be an opt-in looser mode; the fixture `llama33-bedrock-json-integer-as-string` is policy `either` so that choice stays open.
- Llama 4 Maverick's wrapped-argument arrays are not recoverable without guessing, so they stay text.
- `toolSupport.bedrock` still lists neither Kimi, GLM, MiniMax, Nemotron nor Devstral, though all of them returned structured calls here.
- Gemma 3: see the research file.

## Research

See `research-live-recovery.md` content below; sources dated 2026-11-10.

### How others recover Llama JSON in text

- vLLM `llama3_json`: parses Llama 3.1/3.2/4 JSON calls; docs state that "Parallel tool calls are not supported for Llama 3, but it is supported in Llama 4 models", warn of "generating an array serialized as string instead of an array", and recommend `llama4_pythonic` for Llama 4. On a parse failure the parser returns the raw output as content with no tool calls, which is the symptom here. Newer releases scan for `{` and decode with a JSON decoder instead of a brace-matching regex. https://docs.vllm.ai/en/latest/features/tool_calling/ ; parser source docs https://docs.vllm.ai/en/latest/api/vllm/tool_parsers/llama_tool_parser/ (retrieved 2026-11-10).
- vLLM `pythonic`: a Python list of calls; "The model must not generate both text and tool calls in the same generation"; smaller Llama models "frequently fail to emit tool calls in the correct format". Same page.
- LiteLLM keeps the raw JSON as message content when a reply is not recognised as a call (https://git.kvant.cloud/phoenix/litellm-mirror/commit/653a47aea62d8892bd1f268cc5af0eb22aa0e9c7; issue https://github.com/BerriAI/litellm/issues/24091). llama.cpp changed tool-parse failures to stop crashing and fall back to content (https://app.semanticdiff.com/gh/ggml-org/llama.cpp/commit/3cb203c89f60483e349f841684173446ed23c28f). Mezmo AURA documents an opt-in text-detection fallback for Llama-style patterns (https://docs.mezmo.com/aura/ollama-guide). A LocalLLaMA thread reports the same Llama 3.3 behaviour (mixed text and calls, broken brackets) (https://redlib.cypherpunktools.com/r/LocalLLaMA/comments/1ks5oxb/reliable_function_calling_with_vllm/mtizl7f/). Nothing found on OpenHands. Ollama's own Llama handling was not retrievable in this pass; a claim about it is not made.

The pattern across them: parse only when the whole reply is a call, otherwise leave content untouched. That is the strictness chosen here.

### What Meta documents

Llama 3.1: built-in tools are written in Python syntax after `<|python_tag|>` and end with `<|eom_id|>` (needs `Environment: ipython`); custom tools use "Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}. Do not use variables."; without `Environment: ipython` the turn ends with `<eot_id>`. "Llama 8B-Instruct can not reliably maintain a conversation alongside tool calling definitions"; several tools can yield several calls; tool definitions may sit in the user or system prompt and the developer must test which works. https://dev.meta.ai/llama/docs/model-cards-and-prompt-formats/llama3_1 (retrieved 2026-11-10; the llama.com and developer.meta.com URLs redirect there). The `type: "function"` key seen live is not in that format; it is the shape the Llama 3.2+/vLLM templates and OpenAI use. Llama 4 uses a pythonic form per vLLM's template; the live Maverick replies were JSON.

### Why Bedrock returns text for Llama

The Converse documentation applies each model's own chat template, so the caller does not write special tokens, and tool use support is per model. The AWS feature-matrix pages did not load usable per-model rows in this pass (the page returned only the model list), so the reason is inferred, not documented: the model emits JSON text, and Bedrock's server side recognises a structured call only for formats it parses; Llama 3.3's reply ends `end_turn`. Our own earlier measurement that Llama 4 refuses tools only in ConverseStream is in `core/llm/toolSupport.ts`. No documented prompt or system format that changes this was found. https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html (model list only).

### A model that cannot call tools (Gemma 3)

Gemma 3 27B returned prose, code and refusals on all eight prompts. Google's function-calling page documents tools only for Gemma 4 (via `apply_chat_template(tools=...)`, calls as `<|tool_call>call:name{...}<tool_call|>`) and says nothing for Gemma 3 (https://ai.google.dev/gemma/docs/capabilities/function-calling, retrieved 2026-11-10); the corpus already holds `gemma3-has-no-tool-section` and the Gemma 4 fixtures. For Gemma 3 the options are: do not offer tools (current behaviour via toolSupport); or render tools into the prompt ourselves in a format we then parse with a strict recovery (prompted tool use, as `{"name","parameters"}` JSON would be), which is a new dialect with a render path and would be a plan of its own. Not built here.

## Built

- `packages/openai-adapters/src/dialects/llamaJson.ts` and its tests; wired into `recovery.ts`; documented in `docs/ide-extensions/agent/tool-call-recovery.mdx`.
- DSML and thinking-tag filters on every path, both copies (`textFilters.ts`, `core/llm/llms/bedrockHelpers.ts`), with `core/llm/toolDialects/corpus/textFilters.corpus.vitest.ts` running the live replies through both copies and `core/llm/llms/Bedrock.liveReplies.vitest.ts` running them through the core handler.
- Seven observed fixtures; the corpus schema accepts `Observed live on ... <date>, model <id>` as a source.

## Not built

Prompted tool use for Gemma 3, Llama pythonic / `<|python_tag|>` recovery, a looser integer coercion, enabling tools for Llama 3.3, and adding the structured-call families to `toolSupport.bedrock`.
