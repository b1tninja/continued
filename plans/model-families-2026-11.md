# Model families not yet measured: what the vendors say, and what to probe (2026-11-10)

Roadmap rows I2 and I4 and the "Families not yet measured" row list Kimi K3 and K3.1, Kimi K2 Thinking, Grok, GLM 5, MiniMax M2.5, Nemotron, GPT-OSS and Kimi K2.5. Nothing here was measured: no model call was made for this document. Every statement below is from a vendor or AWS page read on 2026-11-10, cited by URL, or marked unverified. The request-builder tables that came out of it (`core/llm/llms/bedrockFamilyRules.ts` and its adapter copy) mark every entry `unprobed` until a probe from `bench/probes/families.yaml` has run. Section 7 records the 2026-11-10 live run that changed six of them to `probed`.

## 1. Decisions

1. **Wire one switch now: Kimi K3 and K3.1 on Converse.** AWS documents `reasoning_effort` (`none`, `low`, `medium`, `high`, `xhigh`, `max`; unset means `max`) and says Converse accepts it in `additionalModelRequestFields` but does not validate it. `bedrockReasoningFields` now sends it when the config says `reasoning: true/false`, and sends nothing by default. Default `max` is the expensive case (output burns 10x quota), so the probe, not the builder, decides whether Loop should default lower.
2. **Do not wire anything else.** For Nemotron 3 Super, GLM 5, MiniMax M2.5, Grok 4.6, GPT-OSS and Kimi K2.5/K2 Thinking the vendor field names are documented for the vendor's own API or for vLLM, not for Bedrock Converse. Guessing a field into `additionalModelRequestFields` risks the DeepSeek R1 failure (every additional field refused). They are table entries with candidate fields for the probe.
3. **Prefer the OpenAI-compatible route for Kimi K3 and K3.1.** AWS says so and says Converse fails (`InternalServerException`) when reasoning content from earlier turns is replayed. Our Bedrock provider is Converse. Either the probe shows the replay fails for us (then strip prior reasoning blocks for `moonshotai.kimi-k3*`, a one-line rule) or K3 goes through the chat-completions adapter on `bedrock-runtime/openai/v1`. Not built; the probe `converse-replay-reasoning` decides.
4. **Grok runs through Mantle or a profile id, not an in-region id.** `xai.grok-4.6` is a Mantle id; on `bedrock-runtime` it only answers as `us.xai.grok-4.6` or `global.xai.grok-4.6`.
5. **Order of the first battery (I4), cheapest first:** GPT-OSS 120B and Nemotron 3 Super, MiniMax M2.5, GLM 5, Kimi K2.5, then Grok 4.6, Kimi K3 (price below), Kimi K3.1 last. K2 Thinking is a Legacy model (end of life 2027-03-30); probe it, do not spend a battery on it.

## 2. Bedrock ids, endpoints, limits

Source for every row: the AWS model card at `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-<provider>-<model>.html` and the endpoint table at https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html, both read 2026-11-10.

| Family                  | bedrock-runtime id                                     | Mantle id                                            | Context / max output | Mantle | Notes                                                                                         |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------- | -------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Kimi K3                 | `moonshotai.kimi-k3`, profiles `us.`, `in.`, `global.` | none                                                 | 1M / not stated      | no     | launched 2026-09-18; $3.00 in, $15.00 out global, US CRIS $3.30 / $16.50; output burndown 10x |
| Kimi K3.1 Pro Highspeed | `moonshotai.kimi-k3.1`, same profiles                  | none                                                 | 1M / not stated      | no     | launched 2026-11-04; US CRIS $4.40 / $22.00; cache read $0.22                                 |
| Kimi K2 Thinking        | `moonshot.kimi-k2-thinking` (no `ai`)                  | `moonshotai.kimi-k2-thinking`                        | 256K / 16K           | yes    | Legacy; the two ids differ; no Responses                                                      |
| Kimi K2.5               | `moonshotai.kimi-k2.5`                                 | same                                                 | 256K / 16K           | yes    | multimodal; already in the matrix                                                             |
| GLM 5                   | `zai.glm-5`                                            | `zai.glm-5`                                          | 200K / 128K          | yes    | no profile; GLM 5.3 exists on runtime only (forced thinking)                                  |
| MiniMax M2.5            | `minimax.minimax-m2.5`                                 | same                                                 | 196K / 8K            | yes    | the 8K output ceiling matters for thinking plus a tool call                                   |
| Nemotron 3 Super 120B   | `nvidia.nemotron-super-3-120b`                         | same                                                 | 256K / 32K           | yes    | 12B active; Nano 3 30B is `nvidia.nemotron-nano-3-30b`                                        |
| Grok 4.6                | `us.xai.grok-4.6`, `global.xai.grok-4.6`               | `xai.grok-4.6` (path `/openai/v1`, `us-west-2` only) | 500K / not stated    | yes    | $2.20 / $6.60 in-region; implicit caching, cache read $0.55; no structured outputs on runtime |
| GPT-OSS 120B            | `openai.gpt-oss-120b-1:0`                              | `openai.gpt-oss-120b` (path `/v1`)                   | 128K / 16K           | yes    | reasoning on by default                                                                       |

An independent March 2026 test (https://zenn.dev/akring/articles/5d0a026a8ede07, third party, one prompt, ap-northeast-1) found `minimax.minimax-m2.5` and `zai.glm-5` listed by Mantle `/v1/models` but not answering. The AWS card now lists both as Mantle-supported; treat the Mantle rows for them as a re-test.

Standard (bedrock-runtime) or Mantle? AWS recommends bedrock-runtime for new applications and, for K3 specifically, its Chat Completions API. Our Converse path needs no new code for the rows that are on it; Mantle is already a provider (`bedrock-mantle`) and is the only route for Grok in-region and for `xai.grok-4.3`.

## 3. Reasoning switch, tool calling, sampling, per family

"Documented" means a vendor page says it for the vendor's own API or a serving stack. None is verified on Bedrock.

### Kimi K3, K3.1

- Reasoning always on; effort `reasoning_effort`: Bedrock card lists `none/low/medium/high/xhigh/max`, default `max`, `minimal` refused (AWS card). Moonshot's own page lists `low`, `high`, `max`, default `max`, and tells you not to pass `thinking` (https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model, 2026-11-10). The two lists disagree on `none` and `medium`; the probe must try both on Bedrock.
- Parameter by API: Responses `reasoning.effort`, Chat Completions `reasoning_effort`, InvokeModel `reasoning_effort` in the body.
- Tool calling: client-side tools supported; structured outputs yes. Native dialect is Kimi special tokens (`kimi-tokens`); ids are `functions.NAME:IDX` (plans/tool-call-styles.md).
- Sampling: third-party guides say sampling parameters are fixed and a 400 follows if sent (unverified; not a vendor page). Moonshot says `temperature` is not modifiable on K2.6 and K2.7-code.
- Quirks: Converse rejects replayed reasoning blocks and PDF/HTML documents; implicit caching on, explicit caching not on Converse; `tool_choice: required` is reported unsupported by one third party and supported by two others (unverified).

### Kimi K2 Thinking, K2.5

- K2 Thinking always reasons (AWS card). K2.5: official API `thinking: {"type": "disabled"}`; vLLM or SGLang `chat_template_kwargs: {"thinking": false}`; recommended temperature 1.0 thinking, 0.6 instant, top_p 0.95 (https://huggingface.co/moonshotai/Kimi-K2.5, 2026-11-10). No Bedrock field is documented, which is why K2.5 "has no reasoning switch in the request builder".
- Multi-turn tool use needs the full assistant message including `reasoning_content` passed back unchanged; set max_tokens at least 16000 (Moonshot page above), but Bedrock caps output at 16K, so a thinking K2 turn can truncate.

### GLM 5

- `thinking: {"type": "enabled" | "disabled"}`, default on for GLM-5; `clear_thinking: false` retains prior reasoning and the full reasoning_content must come back in order (https://docs.z.ai/guides/capabilities/thinking-mode, 2026-11-10). GLM-5.3 cannot be switched off.
- Tools: vLLM parser `glm47` with `--enable-auto-tool-choice`; reasoning parser `glm45` (https://huggingface.co/zai-org/GLM-5). Dialect `glm-xml` (arg_key and arg_value pairs). Our corpus has GLM-4.7 fixtures with null and missing-value cases from vLLM and SGLang issues.
- Sampling: 1.0 / 0.95 for reasoning, 0.7 / 0.95 for SWE-bench, 0.7 / 1.0 for Terminal-Bench 2.0.

### MiniMax M2.5

- Recommended temperature 1.0, top_p 0.95, top_k 40 (https://huggingface.co/MiniMaxAI/MiniMax-M2.5). MiniMax's OpenAI-compatible API ignores `temperature`, `top_p`, penalties and `logit_bias` and takes `n` of 1 only; `reasoning_split: true` puts thinking in `reasoning_content`, else it stays in `<think>` tags in content; thinking tokens count toward `max_completion_tokens` and a small limit returns `finish_reason: length` with empty content (https://platform.minimax.io/docs/api-reference/text-openai-api, 2026-11-10; the page names M3 models for the disable switch and does not cover M2.5, so whether M2.5 can be switched off is unverified).
- Tools: `tools` parameter; append the whole assistant message with `reasoning_content` in later turns. Dialect `minimax-xml`. Bedrock output cap 8K is the binding limit.

### Nemotron 3 Super (and Nano 3)

- AWS card: reasoning effort configurable `none, low, medium, high`. Serving stack: `chat_template_kwargs: {"enable_thinking": false}` turns it off, `low_effort: true` shortens it; `force_nonempty_content: true` recommended for coding agents by Cloudflare; a top-level `reasoning_budget` appears only in an unofficial repository (all from a search digest of https://docs.vllm.ai/en/stable/api/vllm/parser/nemotron_v3/, https://docs.dynamo.nvidia.com/dynamo/recipes/nemotron-3-super and https://developers.cloudflare.com/ai/models/%40cf/nvidia/nemotron-3-120b-a12b/; unverified in detail). The Hugging Face card returned 401.
- Tools: vLLM `--tool-call-parser qwen3_coder`, so the dialect is Qwen XML. The Nano 9B v2 printed its reasoning into `content` on Mantle (Zenn article above).

### Grok 4.6, 4.7

- Reasoning is always on and cannot be turned off; `reasoning_effort` `low`, `medium`, `high` (default; the Bedrock card says default `low`), `xhigh` on 4.6 and 4.7 (https://docs.x.ai/docs/guides/reasoning, 2026-11-10; Bedrock card). On Bedrock the Responses API takes `reasoning: {effort}`. The Chat Completions API does not return reasoning tokens; encrypted reasoning comes back only on Responses with `include: ["reasoning.encrypted_content"]`.
- Sampling: presence penalty, frequency penalty and `stop` return an error on xAI's reasoning models (docs.x.ai page above). Our Converse path sends `stopSequences`; the existing retry for "doesn't support the stopSequences field" is the right shape and the probe confirms the string.
- Tools: client-side calling on Mantle; `tool_choice` not covered by the page (unverified). IAM needs `bedrock:InvokeModel` on the default project on the OpenAI-style routes.

### GPT-OSS

- Effort `low`, `medium`, `high`; the Hugging Face card sets it in the system prompt ("Reasoning: high"); Bedrock card says on by default with the same three levels (https://huggingface.co/openai/gpt-oss-120b, AWS card). The Bedrock request field is not documented there; `reasoning_effort` on Chat Completions is the likely one and is unverified.
- Harmony format only; tools are declared as a `functions` namespace; dialect `harmony`. Mantle has server-side tool calling too; runtime Chat Completions only, not Responses, with `openai.gpt-oss-120b-1:0`. Bedrock refuses `stopSequences` for it (already handled).
- Output returns reasoning in a `reasoning` field; a small `max_tokens` can leave `content` null (Zenn article above, 2026-03).

## 4. What the probes must settle

Each is a row in `bench/probes/families.yaml`, emitted as an `aws` or `curl` command by `bench/probe.mjs`:

1. Does Kimi K3 on Converse accept each of `none, low, medium, high, xhigh, max, minimal` (the AWS note says Converse does not validate, so a value that other APIs refuse may succeed silently)? Does `reasoningContent` come back?
2. Does a Converse turn that replays a prior `reasoningContent` block fail for K3, K3.1 (`InternalServerException`) and for K2 Thinking?
3. Which of `reasoning_effort`, `thinking.type`, `chat_template_kwargs.enable_thinking`, `reasoning.effort` does each other family accept on Converse (`additionalModelRequestFields`) and on Mantle chat completions, and what are the refusal strings?
4. `toolChoice` auto, any, specific tool, per family and route.
5. `temperature` with `topP` together; each alone; `stopSequences`.
6. A 64-token cap with reasoning on: truncation, empty content, `stopReason`.
7. Streaming tool use (Llama 4 and Qwen3 32B needed the non-streaming route).
8. Where the tool call lands: `toolUse` block, or text in the family's dialect (compare with `core/util/toolDialectDetect.ts` fingerprints).

## 5. Cost

Tier 1 is 4 to 15 requests per family at under 300 tokens each. At K3.1 US CRIS prices ($4.40 / $22.00) that is well under ten cents; the output burndown of 10x applies to quota, not price. A Tier 2 slice (`bench/README.md`, about 1.2M input and 40k output) is roughly $4 at K3 US CRIS rates ($3.30 in, $16.50 out), $5.30 at K3.1, $2.65 at Grok 4.6 in-region, against $0.25 for GPT-OSS 120B. Reasoning at the K3 default of `max` multiplies the output side, so the first K3 battery runs at `--effort low`.

## 6. Unverified

- Whether Bedrock Converse takes any of the candidate fields for Nemotron, GLM, MiniMax, Grok, GPT-OSS, K2.5 (documented for other APIs only).
- Whether `none` and `medium` are accepted for Kimi K3 (AWS says yes, Moonshot's page lists neither).
- Kimi K3 max output tokens (the card gives none) and Grok 4.6 max output.
- K3 sampling restrictions and `tool_choice: required` (third-party pages disagree).
- Whether MiniMax M2.5 can be switched off; the platform page documents the switch for M3.
- `reasoning_budget` and `force_nonempty_content` for Nemotron (unofficial and Cloudflare sources).
- The Zenn article's Mantle results are from March 2026 and one prompt; the AWS endpoint table lists GLM 5 and MiniMax M2.5 on Mantle now.
- Pricing for GLM 5, MiniMax M2.5, Nemotron 3 Super, GPT-OSS 120B and K2 Thinking lives on https://aws.amazon.com/bedrock/pricing/, not on the cards; the matrix leaves those rows unpriced so totals are flagged estimated.
- The AWS pages in this document include model names (GPT-6, Claude Mythos 5.2 and others) that are outside this task and were not checked.

## 7. Measured 2026-11-10

Live Bedrock Converse calls, account torgate, us-east-1, one request per case, no retries. Raw requests and responses are in the run's `live/probes/<family>/<family>/<case>.json`, `.out.json` and `.err.txt` (the evidence names in `bedrockFamilyRules.ts` point at them). The table rows in `core/llm/llms/bedrockFamilyRules.ts` and its adapter copy are now `probed` for the six families below; Kimi K2.5 and Grok stay `unprobed` (K2.5 was only a one-token availability call; Grok is AccessDenied on this account).

| Family                            | Worked                                                                                                                   | Rejected or did nothing                                                                                                                                                                                                              | What the request builder does                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Kimi K3 (`us.moonshotai.kimi-k3`) | `reasoning_effort` none, low, medium, max and minimal; a replayed reasoning block; toolChoice auto, any and a named tool | `temperature` (alone and with `topP`) and `stopSequences`: "This model doesn't support the temperature field" / "...the stopSequences field". Reasoning length did not track the effort (44 to 118 chars), so the switch is unproven | omits `temperature` and `stopSequences`; keeps the `reasoning_effort` mapping                     |
| Kimi K2 Thinking                  | a `thinking: disabled` field; replayed reasoning; all three toolChoice forms                                             | the disabled field is ignored, it still reasons; on replay it writes a literal `<think>` block into its text. Sampling and stop not probed                                                                                           | sends no reasoning field                                                                          |
| GLM 5 (`zai.glm-5`)               | `enable_thinking`, `thinking: disabled`, `temperature` with `topP`, toolChoice                                           | `stopSequences`; no reasoning block is ever returned, so there is nothing to switch                                                                                                                                                  | omits `stopSequences`; sends no reasoning field                                                   |
| MiniMax M2.5                      | `reasoning_split` (reasoning came back shorter), `thinking: disabled`, `temperature` with `topP`, toolChoice             | `thinking: disabled` is ignored, it still reasons. `stopSequences` not probed                                                                                                                                                        | sends no reasoning field                                                                          |
| Nemotron 3 Super                  | every reasoning variant tried, `temperature` with `topP`                                                                 | `stopSequences`; no reasoning block returned; toolChoice auto and a named tool add a stray newline text block                                                                                                                        | omits `stopSequences`; sends no reasoning field                                                   |
| gpt-oss-120b                      | `reasoning_effort` low and high (the reasoning visibly changes), `temperature` with `topP`, toolChoice                   | `none`: "Harmony does not support reasoning_effort='none'" (refused by the model, not Converse); `stopSequences`                                                                                                                     | reasoning off sends `low`, never `none`; low, medium, high from the budget; omits `stopSequences` |

Step 1 also found that Kimi K3 and K3.1, Kimi K2 Thinking, MiniMax M2.5 and gpt-oss spend a 20-token `maxTokens` entirely on reasoning and return no visible text. The builders raise a configured `maxTokens` below 1024 to 1024 for those families (`minMaxTokens`). The 1024 is a judgment, not a measured threshold; no run searched for the smallest budget that returns text.

### AWS documentation against the measurements

Read 2026-11-10. AWS does not publish a per-model table of `inferenceConfig` support for Converse: the Converse API reference describes `temperature`, `topP`, `maxTokens` and `stopSequences` as the base parameters and sends model-specific ones through `additionalModelRequestFields`, and the model cards (for example https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html and https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html) say nothing about which of them a model refuses. The refusals above are therefore measured only; a page to cite does not exist, and the table cites the evidence files instead. Where a card speaks, the live data:

- Kimi K3 card: effort values none, low, medium, high, xhigh, max, and "minimal is not supported"; Converse "accepts `reasoning_effort` in `additionalModelRequestFields` but doesn't validate it". Measured: Converse accepted `minimal`, consistent with the note, and the effort did not visibly change the reasoning, which the card does not promise either way.
- Kimi K3 card: Converse "fails (`InternalServerException`) when reasoning content from earlier turns is included in a multi-turn request". Measured: a replayed reasoning block succeeded on 2026-11-10. This contradicts the card; the guidance to strip reasoning from earlier turns is still safe and is kept.
- gpt-oss-120b card: "Reasoning: Supported, on by default (effort configurable: low, medium, high)". Consistent with the live `none` refusal, which the card implies by omission.
- The Kimi K3 card recommends Chat Completions or Responses over Converse; the measured Converse behaviour above is why the builders now work around its refusals instead.
- The "Supported models and model features" page (https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html) did not render a per-model matrix when fetched, so no row of it could be checked against the live data.
