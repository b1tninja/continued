# Forced turns and grammar: the facts and the decision

Next 20 piece 20 (PL7, RQ29 to RQ33, I12). Docs read 2026-11-11; every fact below is `declared` unless it says measured. Nothing here enables a behaviour: `toolConstraint` stays `none`.

## What the product does today

- No turn driver sets `toolChoice`. The field exists on `CompletionOptions`, and two builders honour it: `core/llm/llms/Anthropic.ts` sends `{type: "tool", name}` and `core/llm/llms/OpenAI.ts` (Responses path) sends the named function.
- Both Bedrock builders (`core/llm/llms/Bedrock.ts`, `packages/openai-adapters/src/apis/Bedrock.ts`) send `toolChoice: {auto: {}}` whenever tools are present, for every family (Llama 3.3 writes the call as JSON text without it).
- Nothing sends `response_format`, `json_schema`, a grammar or Ollama `format`; the Ollama builder has `format` commented out. MiniMax's adapter strips `response_format`.
- The only recovery for a call written as text is the parsers (`recoverTextToolCalls`), which run after the fact.

## Facts added (`core/util/surfaceFacts.generated.json`)

New fact names `schemaOutput` (json-schema, json-object, per-model, none) and `grammar` (gbnf, grammar, none); `toolForce` for vLLM and OpenAI Responses. `toolChoice` and `toolForce` for Bedrock (22 families, measured, run bsf-2026-11-10) and the Claude 5.5 generation (declared) were already there.

| Surface            | Forced or named tool                                                                             | Schema-constrained reply                                                                       | Raw grammar                                 | Source                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Anthropic Messages | any/tool honoured; skips thinking; 400 on the 5.5 generation and with manual thinking            | `output_config.format` json_schema; strict tools                                               | none documented                             | platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools, .../build-with-claude/structured-outputs |
| OpenAI Responses   | required, named, allowed_tools                                                                   | `text.format` json_schema strict (Chat `response_format` not read)                             | none documented                             | developers.openai.com/api/docs/guides/function-calling, .../structured-outputs                               |
| Ollama             | declared unsupported (existing row)                                                              | `format` json or schema; `response_format` on /v1; nothing said about `format` with tools      | none documented                             | docs.ollama.com/capabilities/structured-outputs                                                              |
| llama.cpp server   | required declared supported (existing row)                                                       | `response_format`/`json_schema` become a grammar; unsupported schema features skipped silently | `grammar` (GBNF)                            | raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md, .../grammars/README.md           |
| vLLM               | named and required are constrained by structured outputs, need a tool parser; parsable, not good | `response_format` or `structured_outputs`                                                      | `structured_outputs` grammar, regex, choice | docs.vllm.ai/en/latest/features/structured_outputs.html, .../tool_calling.html                               |
| Bedrock Converse   | any/named: measured, 20 of 22 families honour, gpt-oss ignores, Llama 3.x and 4 reject           | `outputConfig.textFormat`, per model (cards not read); first schema compiles for about 90 s    | none                                        | docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html, .../tool-use-client-side.html           |

Not read, so not claimed: OpenAI Chat Completions `response_format`, Ollama grammar, Bedrock per-model structured-output support, llama.cpp `tool_choice` handling (README truncated at 100,000 characters in the fetch; the last 38,720 were read for Realtime only).

## The one consumer

`core/util/forcedToolChoice.ts`, read by `Anthropic.convertArgs`: with `CONTINUE_SURFACE_FACTS=1`, a named tool choice is left out for a surface whose `toolChoice.named` fact is false (Claude 5.5 generation, HTTP 400), only from a declared or measured fact. Unset, the request is byte-identical; a golden test pins that for 4.5 and 5.5 ids.

## Decision: when should the turn driver force a turn

Default stays no force. A forced turn costs the model's ability to answer in text (it must call something, so `report_done` and `ask_user` escape tools are required), skips thinking on Claude, and can only be as good as the schema: vLLM says "parsable, not high quality". Use it only where text recovery has a measured failure bar and the surface fact supports it:

1. Surface honours force (measured, k = n, n >= 8, not stale) and the family writes calls as text (H13: Qwen `<function=...>`, Nova Python form) so recovery has measured misses: force `required` with escape tools on the last step of a plan turn (I12).
2. Claude 5.5 generation, or any surface where force is rejected: `auto` plus strict tools, or `schemaOutput` for a fixed verdict (B13 ladder). Never force.
3. Local engines with a `grammar` fact (llama.cpp, vLLM): a grammar for tool calls is the alternative to recovery; its failure modes are silent skipping of schema features, slow sampling on naive grammars, and a template whose parser fights the grammar. Prefer the engine's own handler with `required` first.
4. Everything else: text recovery (parsers, strict, opt-in), as now.

Failure modes to watch: a model that ignores force (gpt-oss) while the request is accepted, so acceptance is not honouring (`toolForce` is separate from `toolChoice` for this reason); a stray text block beside the call; a question asked in text becoming impossible; cache invalidation when `tool_choice` changes (Anthropic).

## What remains to measure

RQ29 (llama-server grammar against recovery on gpt-oss-20b and Qwen3-Coder-30B), RQ30 (false-call rate on 32 no-tool prompts, escape-tool use, reasoning proxy), RQ32 (json_schema against forced verdict tool), the Mantle `tool_choice` test, Ollama `format` with tools, Bedrock `outputConfig.textFormat` per family.

## Cheapest next experiment (not run)

RQ30 on one local model through the existing llama-server lab: 32 no-tool prompts, `tool_choice: required` with `report_done` and `ask_user` against `auto`, count false calls and escape-tool use. No cloud call, no GPU beyond the lab's one server; if false calls on no-tool prompts exceed zero in 32, `toolConstraint` stays `none` for that family.
