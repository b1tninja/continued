# ToolDialect: design for Track Q

Written 2026-11-10 against `origin/main` of b1tninja/continuous (fetched that day). Read-only research; nothing was built or run. Repo facts cite paths on `origin/main`; web facts cite URLs read or returned by search on 2026-11-10. Anything I could not confirm is in section 11.

## 1. The problem, as measured in our code and bench data

Failures we have logged (ROADMAP H13, `plans/tool-call-styles.md`, `plans/turn-prompt-eval.md`):

- Qwen3-Coder-30B on Bedrock wrote `<function=Write>...</function>` as plain text in 10 replies across 8 of 24 runs (#370). In 4 of 6 full-profile agent runs the run ended `done` with the request untouched. The tailored profile (which quotes the XML markup) brought the 3-of-6 plan-run leak to 0 of 6.
- Nova 2 Lite wrote `present_plan(title=..., decisions=[...])` in Python syntax: 6 of 15 plan replies under the short text, 1 of 25 under the full text (#361).
- Our recovery is only a nudge. `announcesNextStep` in `core/util/turnEnd.ts` reads the last paragraph, which is the function block, so the act nudge never fires. Bench `textLeaks` (`bench/src/common.mjs`) detects leaks with one regex: `<tool_?call|<function=|"name":"(Write|Read|PresentPlan|FinishItem)"`. It does not see the Python form.

What we already do ad hoc, per family, in scattered code. This is the strongest evidence a dialect layer is wanted, because the abstraction exists three times without a name:

| Existing piece                                                                                              | Where                                                                                              | What it is, in dialect terms                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `holdBackDsmlMarker`, `flushDsmlHold`, `leaksDsmlMarker`                                                    | `bedrockHelpers.ts` in both `core/llm/llms/` and `packages/openai-adapters/src/apis/` (two copies) | stream-safe incremental stripping of DeepSeek V3.2's leaked `<｜DSML｜function_calls` marker                                                                                                                                                                                                                                                                                                     |
| `ThinkingTagSplitter`, `writesThinkingTags`                                                                 | same two files                                                                                     | thinking-block handling for Nova 1 family (`<thinking>` in text)                                                                                                                                                                                                                                                                                                                                 |
| `normalizeToolUseIds`, `bedrockToolUseIds` tests                                                            | same                                                                                               | call-id normalisation for Bedrock's id pattern and Mistral                                                                                                                                                                                                                                                                                                                                       |
| `bedrockToolsNeedNonStreaming` (Llama 4, Qwen3 32B: "streams tool input with its opening fragment missing") | same                                                                                               | capability flag: no streamed tool args                                                                                                                                                                                                                                                                                                                                                           |
| `SystemMessageToolsFramework`, `SystemMessageToolCodeblocksFramework`                                       | `core/tools/systemMessageTools/`                                                                   | a render (tool definitions into the system message), parse (`handleToolCallBuffer` streaming state machine), and history-render (`toolCallStateToSystemToolCall`) interface, one format only (a ` ```tool ` block with `TOOL_NAME:` and `BEGIN_ARG:`); wired only in the GUI (`gui/src/redux/thunks/streamNormalInput.ts`), behind `experimental.onlyUseSystemMessageTools`; the CLI has no path |
| `qwenFormat`                                                                                                | `core/llm/prompts/turns.ts`                                                                        | prompt-side render of Qwen's XML vs Hermes in the tailored profile, but the model must write it and nothing parses what it writes                                                                                                                                                                                                                                                                |
| `ToolCallCollector`                                                                                         | `extensions/vscode/src/ai/languageModelChatProvider.ts`                                            | JSON arg accumulation; rejects non-object args rather than repairing                                                                                                                                                                                                                                                                                                                             |
| `streamChatResponse.helpers.ts` (CLI)                                                                       | `extensions/cli/src/stream/`                                                                       | tries `JSON.parse` after every argument delta; no repair, no non-JSON dialects                                                                                                                                                                                                                                                                                                                   |

Two further gaps. First, the failure split is not measured (Q10): we do not know how many leaks were the model writing the wrong form versus the server (Bedrock Converse) not parsing a right one. For Bedrock the server parser is AWS's and not configurable, so on Bedrock a leaked `<function=...>` is by construction something we can only recover client-side. Second, the Qwen3-Coder leaks plausibly share a cause with the outside reports below: a template or parser mismatch.

## 2. What the outside world does (state as of 2026)

### 2.1 Native conventions per family

Sources: `plans/tool-call-styles.md` family matrix (read 2026-11-09), plus the pages below. vLLM's parser table is the single best index; I fetched it 2026-11-10 ([vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/)).

| Family                             | Wire form                                                                                                                                                                                                                                                                                         | vLLM parser                                                                                                                                                | Notes                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-Coder                        | `<tool_call><function=NAME><parameter=KEY>v</parameter></function></tool_call>`                                                                                                                                                                                                                   | `qwen3_xml` (table lists Coder-480B and 30B); older `qwen3_coder` still exists                                                                             | see 2.2 on streaming bugs                                                                                                                                                                                                                                              |
| Qwen2.5, Qwen3 non-coder, QwQ      | Hermes JSON in `<tool_call>`                                                                                                                                                                                                                                                                      | `hermes`                                                                                                                                                   | Qwen docs: function calling is "prompt engineering"                                                                                                                                                                                                                    |
| GLM-4.5/4.6/4.7                    | `<tool_call>NAME` + `<arg_key>`/`<arg_value>` pairs; values typed from the tool schema                                                                                                                                                                                                            | `glm45`, `glm47`                                                                                                                                           | Z.AI tool streaming is opt-in (`tool_stream=true`, GLM-4.6) ([Z.AI](https://docs.z.ai/guides/tools/stream-tool)); SGLang detector streaming had split-name and stall reports ([SGLang PR 11951](https://github.com/sgl-project/sglang/pull/11951), status unconfirmed) |
| DeepSeek V3.2                      | DSML: `function_calls` wrapper, one `invoke` per call, `parameter` elements with a `string="true\|false"` attribute marking literal strings; V4 only renames the wrapper to `tool_calls` and drops think tags ([vLLM deepseek_v32](https://docs.vllm.ai/en/latest/api/vllm/parser/deepseek_v32/)) | `deepseek_v32`/`deepseekv32` (SGLang), `deepseek_v31` for 3.1                                                                                              | V3.2-Speciale does not support tool calling ([SGLang cookbook](https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V3_2)). This is the marker we already strip                                                                                            |
| Kimi K2                            | `<\|tool_calls_section_begin\|>` ... `<\|tool_call_begin\|>functions.NAME:IDX<\|tool_call_argument_begin\|>{json}<\|tool_call_end\|>`                                                                                                                                                             | `kimi_k2`                                                                                                                                                  | id carries name and index; vendor says reset accumulated text after tool calls and that `finish_reason` varies by engine ([Kimi K2 tool-call guidance](https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md))                                    |
| gpt-oss                            | Harmony: assistant message on the `commentary` channel with `to=functions.NAME`, JSON body                                                                                                                                                                                                        | `openai`                                                                                                                                                   | see 2.2                                                                                                                                                                                                                                                                |
| Llama 3.x / 4                      | JSON `{"name","parameters"}` or pythonic                                                                                                                                                                                                                                                          | `llama3_json` (no parallel calls on Llama 3; arrays may come back as strings), `llama4_pythonic`, `pythonic` (cannot mix text and calls in one generation) | per vLLM page                                                                                                                                                                                                                                                          |
| Mistral                            | `[TOOL_CALLS]` + JSON                                                                                                                                                                                                                                                                             | `mistral`                                                                                                                                                  | 9-digit alphanumeric ids required with HF templates; parallel weak on 7B                                                                                                                                                                                               |
| MiniMax M2/M2.5                    | `<minimax:tool_call>` with `<invoke name>` and `<parameter>`                                                                                                                                                                                                                                      | `minimax_m2` (unified parser also does reasoning)                                                                                                          | M2 emits only an end-of-thinking token, so everything before it is reasoning ([vLLM minimax_m2](https://docs.vllm.ai/en/latest/api/vllm/parser/minimax_m2/))                                                                                                           |
| Olmo 3, Granite 4.2, ZAYA, Ripple  | Pythonic in `<function_calls>`; XML; Qwen XML in `<zyphra_tool_call>`; Hermes after `<think>`                                                                                                                                                                                                     | `olmo3`, `granite_toolcall_parser`, `zaya`, `ripple`                                                                                                       | the XML-parameter form is spreading                                                                                                                                                                                                                                    |
| Nova, Claude, Gemini, GPT (hosted) | provider envelope; raw text hidden                                                                                                                                                                                                                                                                | none                                                                                                                                                       | Nova 2 shows reasoning in `<thinking>`; AWS says not to try to remove it; invalid sequences surface as `ModelErrorException` ([AWS Nova troubleshooting](https://docs.aws.amazon.com/nova/latest/userguide/tool-use.html))                                             |
| Gemma, Grok                        | not verified this pass                                                                                                                                                                                                                                                                            | `functiongemma` for FunctionGemma only                                                                                                                     | Grok: no source read. See section 11                                                                                                                                                                                                                                   |

Count of distinct wire shapes: five (JSON in tags or tokens; XML with named parameters; DSML XML with typed attribute; pythonic; routed message). The vLLM table now has more than 35 parsers, which is the cost of not abstracting.

### 2.2 Server-side parsing and known failures

- vLLM `qwen3_coder`/`qwen3_xml`: 2026 issues and PRs include no incremental streaming of long parameters (#30439, fix PR #32536 open when searched), arguments collapsing to `{}` after a boundary delta (PR #43074, reproduces with `--stream-interval 20`), `{}` placeholder args (PR #41466), partial `<parameter=` leaking into content (PR #37829), and reports that switching to `qwen3_xml` removes an endless `!!!!` stream on long inputs ([search result, 2026](https://github.com/vllm-project/vllm/pull/32536)). Merge status of each is unconfirmed.
- vLLM gpt-oss: Harmony control tokens leaking into tool names and recipients (`manage_cart<|channel|>commentary`, causing loops; PR 35901), tool args routed into reasoning or content in streaming (PR 35449), split-across-index args under speculative decoding (PR 37070, March 2026), and an open multi-turn bug as of 0.14.0 ([vLLM forum](https://discuss.vllm.ai/t/status-of-gpt-oss/2316)). Commentary text during a tool turn is returned as `content` of the tool-call response (PR 28729).
- llama.cpp: native handlers for Llama 3.x, Functionary, Hermes 2/3, Qwen 2.5 (incl. Coder), Mistral Nemo, Firefunction, Command R7B, DeepSeek R1 (WIP, "reluctant"), gpt-oss; anything else falls to a "Generic" format that is token-heavy; needs `--jinja`; parallel calls off unless `parallel_tool_calls: true`; aggressive KV-cache quantisation (`-ctk q4_0`) degrades tool calling ([llama.cpp function-calling.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)). No streaming section.
- Ollama: the parser is tied to a per-model renderer/parser pair. Issue #14493 reports Qwen 3.5 mapped to the Hermes pipeline though trained on the Coder XML, and a thinking-plus-tool-call-no-text turn never emitting the closing think tag ([ollama#14493](https://github.com/ollama/ollama/issues/14493)). Continue's own fix #11866 exists because Ollama dropped tool calls when a thinking model returned thinking plus calls and no text. Users fix GLM-4.7-Flash with an explicit `RENDERER glm-4.7` and `PARSER glm-4.7` Modelfile ([HF discussion](https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF/discussions/23)). A single-source field guide claims empty content with `stop` under streaming; treat as unverified.
- LM Studio: two tiers. Native (it formats history through the chat template and parses calls into `tool_calls`) and Default (a custom system prompt, less reliable). Models not trained for tools produce malformed calls it cannot parse ([LM Studio docs](https://lmstudio.ai/docs/developer/openai-compat/tools)).
- SGLang: parsers by name in `function_call_parser.py` (`qwen25`, `qwen3_coder`, `kimi_k2`, `deepseekv3`, `llama3`, `pythonic`, ...), each a `BaseFormatDetector` subclass ([SGLang tool parser](https://docs.sglang.io/advanced_features/tool_parser.html)). Full list not read.

What goes wrong when a client sends OpenAI-format tools, distilled: (1) wrong or missing parser flag turns a correct call into text; (2) parser and template mismatch for a sibling model (Qwen 3.5 on Hermes); (3) streaming partial-argument handling differs per parser; (4) id shape (Kimi, Mistral, Bedrock); (5) thinking-plus-tool turns with empty text; (6) parallel calls unsupported or off by default; (7) arrays or nested values returned as strings (Llama 3 on vLLM). Items 1 to 3 are server bugs a client cannot fix but can recover from; 4 to 7 are ours.

### 2.3 Prior art for client-side normalisation

- OpenHands `fn_call_converter`: forward converter turns function-calling messages into prompt text with an in-context example (`add_in_context_learning_example`), reverse converter parses text back, plus `convert_from_multiple_tool_calls_to_single_tool_call_messages` ([OpenHands docs](https://docs.all-hands.dev/modules/python/openhands/llm/fn_call_converter)). One format for all non-native models. Closest to our Q11, minus per-family dialects.
- LiteLLM: `add_function_to_prompt` appends function details to the system prompt, an old opt-in; tool calls arriving as JSON in `content` is a standing issue class ([LiteLLM #19742](https://github.com/BerriAI/litellm/issues/19742)). It passes through, it does not normalise per family.
- Cline: moved XML to native JSON tool calling in v3.35 (Oct 2025); native Ollama support in 3.54 reportedly broke models without native calling ([plushcap summary](https://www.plushcap.com/content/cline/blog/cline-cline-v335-native-tool-calling-auto-approve-menu-and-free-minimax-m2); the Ollama breakage is from a secondary post, unverified).
- Roo Code: removed XML in 3.37.0 and requires native calling; the stated reasons are maintenance of two paths and the ecosystem direction, with no model-specific numbers ([Roo blog, 2025-12-25](https://blog.roocode.com/p/sorry-we-didnt-listen-sooner-native)). An earlier Roo post argued XML tags may be more reliable; I read only its title.
- Continue (ours, upstream): the system-message-tools framework above. One format (codeblock), GUI only.
- Aider: no tool calling; edit formats instead (Diff-XYZ numbers are in `tool-call-styles.md`). Not prior art for tool-call parsing.

Reading across: the field converged on native envelopes for models whose servers parse correctly, and dropped client-side markup. Our situation differs because we serve through Bedrock Converse and a local Strata server, where parser quality is not ours to choose. The value of a dialect is therefore narrow: recover or render when the server layer fails, and do not pretend to a universal win.

## 3. Interface

Design rules from section 1: it must absorb the existing DSML hold-back, thinking splitter and id logic; it must run in the CLI (which has no system-message-tools path); it must be stream-safe because both the CLI and VS Code consume deltas.

```ts
// packages/openai-adapters/src/dialects/types.ts (proposed)

export interface DialectToolSpec {
  name: string;
  description?: string;
  parameters: JSONSchema; // our registry schema, already name-mapped
}

export interface ParsedCall {
  id: string; // already normalised for the family
  name: string; // registry name (identity unless a name map exists)
  arguments: Record<string, unknown>;
  raw: string; // exact source span, for logging and repair audit
  repaired?: RepairNote[]; // non-empty only if repairArguments changed something
}

export type RepairNote =
  | { kind: "string-to-array"; arg: string }
  | { kind: "string-to-number" | "string-to-boolean"; arg: string }
  | { kind: "unclosed-json"; added: string }
  | { kind: "unescaped-newline"; arg: string };

/** What an incremental parser emits. Text is safe to display now. */
export type DialectEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "call-start"; index: number; id: string; name: string }
  | { type: "call-args-delta"; index: number; json: string } // only if the dialect can stream args as valid JSON prefixes
  | { type: "call-end"; index: number; call: ParsedCall }
  | { type: "malformed"; raw: string; reason: string }; // leaves the span in text, never swallows silently

export interface StreamParser {
  push(chunk: string): DialectEvent[]; // chunk boundaries arbitrary, may split any token
  end(): DialectEvent[]; // flush held text; unterminated call becomes malformed
}

export interface DialectCapabilities {
  parallelCalls: boolean;
  streamsArguments: boolean; // false: emit call-end only
  nestedArguments: boolean; // false: registry flattens or refuses the tool
  textAndCallInOneTurn: boolean; // false for pythonic parsers
  idShape: RegExp | null; // required shape, e.g. /^[A-Za-z0-9]{9}$/ for Mistral
  thinkingInText: "none" | "tags" | "end-token-only";
}

export interface ToolDialect {
  readonly id: string; // "identity" | "qwen-xml" | "hermes-json" | "pythonic" | "dsml" | "kimi-tokens" | "harmony" | "glm-xml"
  readonly capabilities: DialectCapabilities;

  /** Native-envelope path: adjust the request body, nothing is rendered into text. */
  prepareRequest?(req: OpenAIChatRequest): OpenAIChatRequest;

  /** Text path: tool list as the family reads it. Must be byte-stable (see section 6). */
  renderTools(tools: DialectToolSpec[]): string;

  /** History: assistant tool calls and tool results as the family writes them. */
  renderToolCall(call: ParsedCall): string;
  renderToolResult(callId: string, name: string, content: string): string;

  /** Text path: streaming parse. Fresh instance per model response. */
  createParser(tools: DialectToolSpec[]): StreamParser;

  /** One-shot parse of a complete reply (used by the non-streaming Converse path and corpora tests). */
  parseComplete(
    text: string,
    tools: DialectToolSpec[],
  ): { events: DialectEvent[] };

  /** Coerce to the declared schema; never invent keys, never drop unknown ones silently. */
  repairArguments(
    call: ParsedCall,
    schema: JSONSchema,
  ): ParsedCall | { rejected: string };

  normaliseId(id: string, position: number): string;
}
```

Mapping to the nine jobs in `tool-call-styles.md`:

- Names and arguments: a separate `NameMap` in the registry, applied around the dialect, not inside it. Q2 is unmeasured, so the interface does not make names a dialect concern until a win exists.
- Edit shape: out of scope for this interface (Q3).
- Render: `renderTools`, `renderToolCall`, `renderToolResult`.
- Parse and repair: `createParser`, `parseComplete`, `repairArguments`.
- Ids and history: `normaliseId`, `idShape`.
- Capabilities: `capabilities`.
- Thinking: parsers emit `thinking` events. The existing `ThinkingTagSplitter` becomes a shared combinator wrapped around any text-path parser rather than a Bedrock-only class.

Streaming invariants every parser must satisfy (tested in section 7): the concatenation of `text` events plus the `raw` of calls and malformed spans equals the input; no call is emitted twice; arguments never emitted unless they are a valid JSON prefix of the final arguments; a partial marker at the end of a chunk is held, never shown (generalising `holdBackDsmlMarker`); `end()` on an unterminated call yields `malformed`, not a silent drop. The DSML hold-back already in tree is an instance of the last rule, so Q-row one reuses its tests.

Argument repair is the part to be most restrictive about. Allowed: closing unbalanced JSON when the stream ended at a token boundary, coercing `"3"` to 3 or a JSON-looking string to an array where the registry schema declares it (the Llama 3 array-as-string failure), unescaping literal newlines inside strings. Not allowed: guessing a missing required argument, renaming keys, picking among multiple candidate tools. The existing rule, "only when exact and unambiguous", stays. Every repair is recorded in `repaired` so the bench counts it.

## 4. Which dialects first, with evidence

Rank by (observed failures in our data) x (family we serve) x (cheapness of the parser).

1. `qwen-xml` (Qwen3-Coder). The only family with a measured leak rate (8 of 24 runs, 10 replies) and a format we already quote in the tailored prompt. The grammar is small and fixed, vLLM's own table lists it under one parser, and Granite 4.2 and ZAYA reuse it, so the parser has reach. First use: recover from text on the Bedrock path (Q5), which needs no prompt change. The tag is already matched by `textLeaks`, so the bench can score it unchanged.
2. `pythonic` (Nova 2 Lite's `present_plan(...)`; also Llama 4, Olmo 3). Observed failures exist but are rarer (1 in 25 under the full text, up to 6 of 15 under the short text). The risk is false positives: Python call syntax in prose or code fences looks like a call. So recovery is gated: only when the name is in the current tool list, the call is the whole final paragraph, and arguments parse with a literal-only grammar (no evaluation, ever). Not a first slice.
3. `dsml` (DeepSeek V3.2). Not a recovery case; it is a strip case we already have. Fold the existing hold-back into the dialect as the first refactor row, with zero behaviour change. That proves the interface against real code.
4. `hermes-json` (Qwen3 non-coder). Format trivial; no logged leak. Build only when a Qwen3 non-coder leak is measured. It also gives the JSON-in-content recovery that Ollama and LiteLLM users report.
5. Later and evidence-gated: `kimi-tokens` and id normalisation (Kimi is on Bedrock but no failure is logged; vLLM's guidance says history ids in another shape cause invented ids), `harmony` (gpt-oss on Bedrock goes through Converse so the server parses; Harmony matters only for a self-hosted server and the vLLM bugs above are server-side), `glm-xml`, `minimax-xml`.

Not in the first set, with the reason: Gemma and Grok (no source read), Mistral (id shape already handled in `bedrockToolIds`), Llama 3 JSON (Bedrock Llama 4 already non-streaming).

Honest scoping: on Bedrock with AWS parsing, a dialect's render path is rarely needed; the recover path is. The render path pays only for local servers and for models with no tool support, where `onlyUseSystemMessageTools` is the existing hook.

## 5. Where it plugs in

Options:

- Adapter (`packages/openai-adapters`): the layer that sees raw model text and the provider envelope, shared by the CLI. Bedrock's stream handler already holds the DSML and thinking state here. Right home for `createParser` (recover) and `repairArguments`.
- `core/llm`: duplicate of the Bedrock helpers exists here for the IDE (comment in `bedrockToolsNeedNonStreaming`: "two copies"). Adding a dialect to both copies repeats the existing duplication debt.
- CLI (`extensions/cli/src/stream/`): sees only OpenAI-shaped deltas; cannot see raw text a provider parsed. Only suitable for a post-hoc check on assistant text (H13's nudge) and for argument repair on `argumentsStr`.

Decision: put `ToolDialect` and all dialects in a single new module in `packages/openai-adapters`, and have `core/llm/llms/Bedrock.ts` import it rather than copy it (the vscode extension and core already depend on that package, to be confirmed in Q11). The CLI keeps one hook, `repairArguments`, in `streamChatResponse.helpers.ts` where it currently calls `JSON.parse` per delta. GUI `systemMessageTools` stays as is until a dialect can subsume its codeblock framework (a late row, not required).

Selection: by model id through a `dialectFor(modelId)` table mirroring `promptProfile`, overridable per model in config; default `identity`. `identity` must pass today's streaming bytes unchanged, and the existing DSML and thinking logic moves behind it only in rows that show unchanged test output.

Interaction with the prompt cache (Track C):

- `renderTools` output sits in the system or tools prefix; any nondeterminism busts the cache. Requirements: tools sorted by a stable key, schema keys emitted in sorted order, no timestamps or ids, no per-turn variation. A dialect carries a `renderTools` snapshot test and the bench's "prefix churn" column (I6, already measures zero churn inside an attempt) is the acceptance check.
- Switching dialect mid-conversation changes the prefix: treat as a cache break, same class as switching model.
- `renderToolCall` re-renders history. It must be a pure function of the stored call, so the same history renders the same bytes each turn. History must store the registry form, not the rendered text, and rerender, else a dialect change rewrites history.
- Native-envelope path leaves the prefix untouched, so the cache points for Claude and Nova (C47 to C60) are unaffected. This is the second reason recovery-first is the right order.

## 6. Test strategy

1. Golden corpora from real output. Capture raw model text (before server parsing) from the bench: Bedrock Qwen3-Coder and Nova 2 Lite leaks already sit in run histories (`textLeaks` entries, truncated to 200 chars today; raise the capture to the full reply). Store as `corpus/<family>/<case>.txt` plus the expected `ParsedCall[]` JSON. Aim for at least 20 per dialect, including the failures: truncated at `max_tokens`, nested JSON in a parameter, a literal `</parameter>` inside a value, two calls in one reply, text before and after.
2. Round trip. `parseComplete(renderToolCall(c))` equals `c` for generated calls over each tool's schema (property-based over our registry schemas). This also catches rendering that cannot be parsed back.
3. Fuzzed splits. For every corpus file, split into 1 to N chunks at random byte and codepoint boundaries (include the fullwidth bars of DSML and multi-byte characters) and require identical events to the unsplit parse, plus the streaming invariants in section 3. Run N = 1, 2, 7, one character per chunk.
4. Negative corpus: prose that mentions `<tool_call>` in an explanation, a fenced Python snippet that looks like `present_plan(...)`, and a tool result that quotes a call. Required output: zero calls. This is where recovery either ships or does not.
5. Existing tests untouched: DSML, thinking-splitter and id tests pass against the new homes.
6. Live (gated, optional): extend `Bedrock.turns.live.vitest.ts` with one recovery assertion.

## 7. Measured-win plan using the bench

The bench already records invalid calls, `textLeaks`, completion, requests per attempt and cost, `n=5` per cell (`bench/matrix.yaml`, `bench/score.mjs`). Plan:

1. Q10 first: re-score existing run histories with a split classifier, parsed / leaked-recoverable / leaked-unrecoverable / wrong-arguments, per model. This sets the ceiling. If leaks on Qwen3-Coder are 80% of failures and the parser recovers them, the ceiling is large; if the model is simply wrong, it is small.
2. Arms: `--dialect off|recover|render+recover` on the runner (new flag, like `--tail`). Models: qwen3-coder-30b, nova2lite, qwen3.8-flash (Strata, free), haiku45 as the control that must not change.
3. Metrics: leaks per run, runs ending `done` with the request untouched, completion, requests per attempt, repaired-call count, false-call count (a negative scenario in `agent-acts` that discusses `<function=Write>` and must not execute).
4. Bar: a dialect ships if completion does not fall and leaks fall, at n=5 per arm, and false calls are 0 across the negative corpus and negative scenarios. The control model must be byte-identical. Report the per-cell variance honestly: n=5 cannot resolve a few points of completion, and the Nova figures above come from runs of 15 and 25 replies.
5. Cost column (I11) before claiming render wins, since render adds prompt tokens.

## 8. Risks

- False positives executing a call the model only mentioned. Mitigation: names must be in the live tool list, the span must be the entire tail of the reply, a recovered call goes through normal permission policy, and `raw` is logged. Never evaluate Python.
- Masking the real bug. If Qwen3-Coder leaks because a server template is wrong, recovery hides it. Q10 exists to prevent that; recover events carry a counter surfaced in `cn serve` output.
- Duplication debt: a third copy of helper code. Mitigation: one module, imported by core.
- Parser churn: vLLM changed `qwen3_coder` to `qwen3_xml` and keeps patching streaming. Our parser is a client-side fallback, not a reimplementation; keep each dialect under a few hundred lines and corpus-tested.
- Cache regressions from unstable rendering (section 5).
- Policy and lint bypass: recovered calls must enter the same path as native ones so command lint and protected paths apply. Checking this is an acceptance item.
- Scope creep into names and edit formats before Q2 and Q3 measure anything.
- A reply of text-plus-call on a dialect with `textAndCallInOneTurn: false`.

## 9. Build rows

Numbered after the existing Q19 (these rows were Q14 to Q24 until ROADMAP took Q14 to Q19 for other work). Dependencies on Q1 to Q19 are roadmap ids.

| Row | Slice                                                                                                                                              | Depends  | Exit                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| Q20 | Re-score existing bench histories with the failure split (parsed, recoverable leak, unrecoverable, wrong args), full-reply capture in `textLeaks`  | Q10      | table per model and run; decides Q22                                                    |
| Q21 | `ToolDialect` types and `identity` in `packages/openai-adapters`; core imports it; no behaviour change                                             | Q11      | existing tool tests green byte-for-byte                                                 |
| Q22 | Move DSML hold-back and `ThinkingTagSplitter` behind the interface as `dsml` and a shared combinator; delete the second copy                       | Q21      | old tests pass in the new home; one copy remains                                        |
| Q23 | Fuzzed-split harness and negative corpus, as a reusable test helper                                                                                | Q21      | runs against Q22 parsers                                                                |
| Q24 | `qwen-xml` parser with `parseComplete`, stream parser and `repairArguments`; corpus from bench histories                                           | Q20, Q23 | passes corpus, round trip, splits, negatives                                            |
| Q25 | Recover path in the Bedrock stream handler behind `--dialect recover`, plus runner flag and scorer columns                                         | Q24      | bench result at n=5 per section 7; ship only on a win (this is Q5)                      |
| Q26 | CLI `repairArguments` hook replacing per-delta `JSON.parse` fallthrough; `ToolCallCollector` likewise                                              | Q21      | rejected calls surface a specific error; a case where today args are rejected now parse |
| Q27 | `pythonic` recovery for Nova 2 Lite, gated per section 4                                                                                           | Q23, Q25 | zero false calls on negatives; leaks fall                                               |
| Q28 | Render path (`renderTools`, `renderToolCall`) for `qwen-xml`, tested for byte stability under the cache simulator (`plans/prompt-caching-sim.mjs`) | Q24      | zero prefix churn; render arm measured                                                  |
| Q29 | `hermes-json` and `kimi-tokens` with id normalisation (Q13)                                                                                        | Q25      | only if a leak or id failure is logged                                                  |
| Q30 | Decide whether `SystemMessageToolCodeblocksFramework` becomes a dialect and the CLI gets that path                                                 | Q28      | decision note                                                                           |

Q20 to Q22 are mergeable in any order after Q21 and change nothing observable. Q25 is the first row that can change what the user sees.

## 10. Decisions this doc asks the owner for

1. Recover first, render later (my recommendation, from section 5): yes or no.
2. One module in `openai-adapters`, core imports it: confirm core and vscode can take that dependency.
3. Are Bedrock leaks counted as ours to fix client-side even if a server template is the cause?

## 11. Unverified

- Grok, Gemma 3, Llama 3.1 `<|python_tag|>`, Mistral v11 form, Nova's own text form when it leaks: not read this pass. The Python-syntax claim for Nova 2 Lite is from our own bench only; AWS pages searched do not mention it.
- Whether Bedrock Converse applies any server-side parser to Qwen3-Coder or just passes template output: not established; it decides the size of the recoverable share.
- Merge status of each vLLM and SGLang PR named in 2.2; `qwen3_coder` against `qwen3_xml` robustness is a blog and anecdote claim.
- Ollama single-source "empty content with stop" claim; Cline-Ollama breakage; vLLM issue numbers beyond those quoted by search summaries (I did not open the PRs).
- SGLang's complete parser list; LM Studio's current native list.
- Roo's claim that XML "may be more reliable" (title only).
- Whether `core` and the VS Code extension can import `packages/openai-adapters` without a build-order cost.
- Whether Strata's server runs `qwen3_xml`, `qwen3_coder` or Hermes for each served model (that is Q1 itself).
- Every bench number above is quoted from `plans/ROADMAP.md` and `plans/turn-prompt-eval.md`; I did not re-run or re-derive any.
