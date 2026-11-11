# Detecting the tool-call dialect when the model id does not say

Addendum to `research-tool-dialects.md`. Written 2026-11-10. Web facts cite the URL read that day. Anything not read is in section 9. Code for the first slice is in `core/util/toolDialectDetect.ts` (pure, unwired).

## 1. The decision in one paragraph

A table keyed on the model id is a guess that custom endpoints break (fine-tunes, renamed models, gateways). Metadata is a better guess about what the model was trained to write. Neither says whether the server parses that markup into `tool_calls`, which is the question that decides whether we recover, render or do nothing. Only observation answers that: one cheap probe and every real reply we see afterwards. So the procedure answers two questions separately: which family (table, metadata, observed markup, combined) and which transport (native, markup left in content, or no tool format at all; observation only). When unsure, behave exactly as today: send OpenAI tools, parse nothing extra.

## 2. Passive signals: what endpoints reveal

| Server               | Signal                                                                                                                                                                                                                                                                                                              | Source (read 2026-11-10)                                                                                           | Value for us                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| llama.cpp            | `GET /props` returns `chat_template` ("the model's original Jinja2 prompt template"), `chat_template_caps`, `modalities`, `model_path`. `/v1/models` `id` defaults to the model file path unless `--alias`. Function calling needs `--jinja` (default enabled); `parallel_tool_calls` is decided from the template. | https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md (first 100k of 138k chars read) | Best passive signal: the full template is returned. Sniff it for the family's literals. The server's own format detection is internal and not documented, so we cannot read which handler it picked                            |
| Ollama               | `POST /api/show` returns `template`, `capabilities` (example `["completion","vision"]`; `tools` appears for tool-capable models, not confirmed in the page), `details` (family, format, quantization), `model_info` (architecture)                                                                                  | https://github.com/ollama/ollama/blob/main/docs/api.md                                                             | Template sniffing works. `capabilities` containing `tools` says the server has a parser, not which. Ollama pairs a renderer/parser by model name, so a renamed model can get the wrong pair (see ollama#14493 in the base doc) |
| LM Studio            | `GET /api/v0/models`: `id`, `type`, `publisher`, `arch`, `compatibility_type`, `quantization`, `state`, `max_context_length`. No capabilities or tool flag documented                                                                                                                                               | https://lmstudio.ai/docs/developer/rest/endpoints                                                                  | `arch` (for example `qwen2_vl`, `llama`) is a family hint only; no template                                                                                                                                                    |
| vLLM                 | `/v1/models` lists the served model id; the tools page documents neither `/v1/models` nor `/version` and does not say the server exposes its `--tool-call-parser`                                                                                                                                                   | https://docs.vllm.ai/en/latest/features/tool_calling/                                                              | The parser flag is invisible. `--served-model-name` can rename anything. Only `id` and, from memory, `root` (the HF path) are useful                                                                                           |
| SGLang               | `--tool-call-parser` names: deepseekv3, deepseekv31, deepseekv32, glm, gpt-oss, kimi_k2, llama3, llama4, mistral, pythonic, qwen, qwen3_coder, step3, apertus2509 and others. The page names `/generate` and `/parse_function_call` but no `get_model_info`                                                         | https://docs.sglang.io/advanced_features/tool_parser.html                                                          | The parser is not exposed either. `/parse_function_call` is an interesting active tool: it parses text with a named parser, but it needs the parser name, so no                                                                |
| OpenRouter, gateways | OpenRouter lists `supported_parameters` per model (docs page not fetched, 404); LiteLLM exposes `supports_function_calling(model)` from its own static table                                                                                                                                                        | https://docs.litellm.ai/docs/completion/function_call                                                              | Both are tables, not detection; a gateway typically hides the backend and the template                                                                                                                                         |

What a custom gateway hides: the backend server, its parser flag, the template, and usually the real model name. `owned_by` is a free-text field the gateway sets; treat it as noise.

Model-id patterns remain the cheapest first lookup (`qwen3-coder`, `glm-4`, `kimi-k2`, `gpt-oss`, `deepseek-v3`). Quantised and fine-tuned names usually keep the base name (`Qwen3-Coder-30B-A3B-Instruct-AWQ`), so a substring table survives most renames; it fails on `my-company-coder-v7`.

## 3. Output signals: fingerprints

Each family's markup, what it is derived from, and the fingerprint the classifier uses. "Template" means literal strings read from the vendor's chat template; "doc" means a vendor or server doc; "memory" means unverified.

| Dialect                                           | Markup                                                                                                                         | Source                                                                                                                                                    | Strong fingerprint                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| qwen-xml (Qwen3-Coder)                            | `<tool_call>\n<function=NAME>\n<parameter=KEY>\nv\n</parameter>\n</function>\n</tool_call>`                                    | template https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/chat_template.jinja                                                            | `<function=NAME>` then `<parameter=` or `</function>`; or `<parameter=NAME>`            |
| hermes-json (Qwen2.5, Qwen3 non-coder)            | `<tool_call>\n{"name":..,"arguments":{..}}\n</tool_call>`                                                                      | memory                                                                                                                                                    | `<tool_call>` then `{"name":`                                                           |
| glm-xml                                           | `<tool_call>NAME<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`                                                      | template https://huggingface.co/zai-org/GLM-4.5/raw/main/chat_template.jinja                                                                              | `<tool_call>NAME<arg_key>`                                                              |
| dsml (DeepSeek V3.2)                              | fullwidth-bar `<｜DSML｜function_calls>` with `invoke name=` and `parameter name= string=`                                     | marker observed in our Bedrock code; rest from the vLLM page via base doc                                                                                 | `<｜DSML｜(function_calls\|tool_calls\|invoke)`, ASCII `                                | ` accepted |
| kimi-tokens                                       | `<\|tool_calls_section_begin\|><\|tool_call_begin\|>functions.NAME:IDX<\|tool_call_argument_begin\|>{json}<\|tool_call_end\|>` | tokens from tokenizer_config.json; `functions.NAME:IDX` from the Kimi guidance https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md | section token, or `<\|tool_call_begin\|>functions.X:N`                                  |
| harmony (gpt-oss)                                 | `<\|channel\|>commentary to=functions.NAME <\|constrain\|>json<\|message\|>{json}<\|call\|>`                                   | https://github.com/openai/harmony/blob/main/docs/format.md                                                                                                | `to=functions.X` before `<\|constrain\|>` or `<\|message\|>`                            |
| mistral                                           | `[TOOL_CALLS]` then a JSON list                                                                                                | token verbatim; body memory                                                                                                                               | `[TOOL_CALLS]` followed by `[` or `{`                                                   |
| llama function tag                                | `<function=NAME>{json}</function>`                                                                                             | memory (llama.com page redirected, not read)                                                                                                              | `<function=NAME>` then `{`                                                              |
| llama python tag                                  | `<\|python_tag\|>`                                                                                                             | memory                                                                                                                                                    | the token                                                                               |
| pythonic (Llama 4, Olmo 3, Nova 2 Lite as logged) | `[f(a='x'), g(b=1)]`                                                                                                           | vLLM tools page, verbatim                                                                                                                                 | whole reply is one call expression; confidence high only if the name is an offered tool |
| functiongemma                                     | `<start_function_call>call:NAME{k:<escape>v<escape>}<end_function_call>`                                                       | vLLM page, verbatim                                                                                                                                       | `<start_function_call>call:`                                                            |
| minimax                                           | `<minimax:tool_call><invoke name=..>`                                                                                          | base doc                                                                                                                                                  | the tag                                                                                 |

Distinguishing neighbours: Qwen XML and the Llama function tag share `<function=`; the next token (`<parameter=` versus `{`) separates them. Qwen XML, GLM and Hermes share `<tool_call>`; what follows the tag separates them. Both facts are tested.

Thinking tags: `<think>...</think>` (Qwen3, GLM, DeepSeek R1 family), `<thinking>` (Nova per base doc), Harmony `<|channel|>analysis`. The classifier reports the convention separately; it does not change the dialect.

The leak identifies the dialect. When a server fails to parse, the model's native markup lands in `content` unchanged (our Qwen3-Coder leaks, the DSML marker before Bedrock toolUse blocks, vLLM issues quoted in the base doc where `<parameter=` leaks into content). A leak is therefore stronger evidence of the family than any metadata, and it is also proof the transport is not native.

False-positive controls (tested in the negative corpus): markup inside fenced code or inline backticks is a mention and never classifies; a pythonic call must be the whole reply and its name must be an offered tool to reach the accept bar; a bare JSON object with `name` and `parameters`/`arguments` stays advisory (0.7) because an answer can look the same; a weak marker alone (0.6) never triggers recovery.

## 4. Active probing

Probe request (`probeRequestFor`): one inert tool (`dialect_probe_echo(text, count)`), temperature 0, `tool_choice: auto`, 400 max tokens, a prompt that asks for two calls in one turn: the first with a text containing double quotes, the second with a newline. Unicode lives in the fixtures for verifying round trips (a third text, `café ☃`, is exported; the current prompt does not use it, to keep two calls). The tool is not a real tool; the caller must never execute the calls.

Classification of the reply:

- Structured `tool_calls`: native. Then `verifyProbeCalls` checks parallel (two calls), argument integrity (valid JSON, exact text including the escaped quote and newline, integer count) and ids. Native with broken integrity is still native but is recorded; that is the Llama-3-style failure class in the base doc.
- Markup in content: a dialect, recoverable client side. Confidence 0.97 when closed, 0.88 when truncated (still accept: a truncation is common at low max_tokens).
- Prose or empty: no usable native format. If a family is already known from the table or metadata, render that family's text form; if not, default.

Cost and risk: about 150 prompt tokens plus 50 to 150 completion tokens; one round trip, typically under 2 seconds locally, longer on a cold-loading llama.cpp or LM Studio model (loading may exceed a short timeout; treat timeout as no result, not as prose). Reasoning models may spend the whole budget thinking: if `finish_reason` is length and content is empty, record unknown, do not conclude. Rate limits: one call per endpoint per TTL. No side effects because the tool is made up. A gateway with guardrails may refuse or rewrite; that reads as prose, so prose from a hosted gateway must not outvote a table entry (see section 5).

When to run: (1) add-model wizard "Test connection", where a one-off cost is expected; (2) first use of an endpoint+model with no table hit and no cached result; (3) after the first live leak or parse failure, to confirm. Never before every session.

Cache: key `(baseUrl, model id, apiKey hash not stored)`; value `{decision, probedAt, probeVersion}`; TTL 24 h (`PROBE_TTL_MS`) because servers restart with different flags; invalidated by any change of base URL or model, and by a live leak. A manual config override (`toolDialect: qwen-xml | native | auto`) always wins and disables the probe.

Parallel calls: the probe asks for two; many parsers handle one (Llama 3 on vLLM per base doc). A single call returned is recorded as `parallel: false`, which feeds a capability flag later, not the dialect.

## 5. Confidence model and decision procedure

Sources and weights (exported as `SOURCE_WEIGHT`): table 0.85, metadata 0.9, probe 1.0, live leak 1.0. Weights multiply the source's own confidence. Independent sources for the same family combine by noisy-OR, `1 - Π(1 - sᵢ)`, so agreement raises confidence and a single weak signal cannot reach the accept bar alone. Thresholds: `ACCEPT_THRESHOLD` 0.8 (act: recover or trust native), `ADVISORY_THRESHOLD` 0.5 (hint or log), `CONFLICT_MARGIN` 0.2.

Procedure (`decideDialect`):

1. Family. Combine table, metadata and any markup seen in the probe or live replies. A family seen in output at 0.8 or more is decisive and outranks any guess. Otherwise, if the top two guesses are both advisory and within 0.2, it is a conflict: no family, default behaviour.
2. Transport, from observation only. Live markup at 0.8 or more means recover, even if the probe was clean (the server failed once). Else a structured probe or reply at 0.8 or more means native. Else prose at 0.8 or more means render.
3. recover and render require a family at 0.8 or more; without one the answer falls back to default. A native verdict does not need a family.
4. Nothing decisive: mode default, which equals today's behaviour. A table or metadata hit alone is advisory (0.85 and 0.81) and never changes transport.
5. Output: family, mode, confidence, level (accept, advisory, none), conflict flag and reasons for logs.

Why a table alone never recovers: the server might already parse it, and recovering over a native pipeline risks double calls. Why a leak always can: it is proof.

## 6. Prior art

- llama.cpp picks a handler by inspecting the Jinja template; unknown templates fall to a generic format (base doc 2.2). It is the closest thing to detection in the wild, and it is server-side.
- LiteLLM: `supports_function_calling` reads a static table; `add_function_to_prompt` is a manual flag, not triggered by detection (https://docs.litellm.ai/docs/completion/function_call).
- OpenHands, Cline, Roo: one format chosen up front or native only; no per-endpoint detection (base doc 2.3). Cline and Roo moved to native calling, which dodges the problem and leaves leaks unhandled.
- Continue today: the experimental system-message-tools flag is a manual switch; `promptProfile` and `qwenFormat` in `turns.ts` choose by model-id regex; CLI `isModelCapable` is a name-pattern list (`extensions/cli/src/utils/modelCapability.ts`). No probe, no leak feedback.
- BFCL separates function-calling handlers from prompt-based ones by a model-name suffix (`-FC`) and a hand-written handler class per model (README, https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/README.md). That is a table, and it confirms a table is what a leaderboard with full control uses.
- OpenRouter `supported_parameters`: not verified (docs 404).
- Aider `model-settings`: not read; it is a per-model YAML override, i.e. a table plus manual override.

Reading across: nobody probes. A probe plus leak observation is new relative to these, which is a reason to keep it small, cached and overridable.

## 7. What is built (slice 1) and what is not

Built, pure and unwired, in `core/util`: `classifyToolReply`, `dialectFromChatTemplate`, `probeRequestFor`, `verifyProbeCalls`, `decideDialect`, the threshold and weight constants; fixtures with provenance; negative corpus. Not built: any request-path wiring, the probe sender, cache, config override, wizard integration, the stream-safe recovery parser (Q18), metadata JSON parsing (next slice), live validation against real servers.

## 8. Decisions for the owner

1. Is a probe in the add-model "Test connection" acceptable (one extra call, a made-up tool)?
2. Config key name and values for the manual override (`toolDialect`), and whether it belongs beside `promptProfile`.
3. Should a live leak flip an endpoint to recover automatically, or only warn until Q34 is measured?

## 9. Unverified

- Hermes, Mistral body, Llama 3.1 function tag, `<|python_tag|>`, Llama JSON: bytes from memory; fixtures marked reconstructed.
- DSML full call body and Kimi full line: assembled, not captured.
- vLLM `/v1/models` fields (`owned_by`, `root`, `max_model_len`) and `/version`: search found no source; the tools page documents neither.
- Ollama `capabilities` containing `tools`: the page shows only `completion`, `vision`. The docs.ollama.com URL returned 404.
- OpenRouter `supported_parameters` and the Aider model-settings format: not read.
- SGLang `get_model_info`: not in the parser page; may exist elsewhere.
- Whether llama.cpp exposes which tool handler it chose: not in the README portion read (38k chars unread).
- Probe latency and token figures are estimates, not measured.
- Whether Bedrock Converse applies a parser to custom-import or marketplace models: unknown.
