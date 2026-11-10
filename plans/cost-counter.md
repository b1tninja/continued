# Cost counter: where prices come from, what the loop must never assume

Status: plan and research, 2026-11-10. Builds on `loop-budgets.md` (T0, T5, T9), `usage-display.md` and `prompt-caching.md`. All web pages below were read on 2026-11-10 unless a date is given.

## Decision summary

1. **Keep the checked-in tables as the source of prices; do not fetch at runtime.** A loop's dollar limit must give the same answer offline, in CI and in a test. Each row carries a source URL and a date. Add a monthly human-reviewed refresh, not an auto-updater.
2. **A cost is a number or the word `unknown`, never a guess.** `costOf` returns `amount: number | "unknown"` plus the assumptions it made. Unknown is never summed as zero; a dollar budget is not enforced while the cost is unknown, and the UI says so.
3. **Price list, standard tier, global or in-region rate, as the default; say so.** Batch, flex, fast (priority), data-residency and long-context modifiers are applied only when the usage record carries the evidence (a tier field, a model-ID prefix, a prompt length). Otherwise the assumption "standard tier" is printed.
4. **Local and self-hosted models are `unknown` by default, and zero only when the person says so.** A user-entered price (including an explicit 0) is the only way to enforce a dollar budget on them.
5. **The estimate is a list-price estimate and is labelled as one.** Claude Code does the same.

## Where reliable prices come from

| Source                                                                                                                                                                                                  | What it gives                                                                                                                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider pricing pages                                                                                                                                                                                  | Authoritative, human-readable, change without notice                                                                                                                                                                                                                                       | The reference to cite per row; no stable schema, so not machine-fetched                                                                                                                                                                                                                                                                                         |
| AWS Price List API / bulk file (offer `AmazonBedrock`, `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/index.json`; boto3 `pricing.get_products`, endpoint in us-east-1) | Per-region, per-usage-type rows (`USE1-...-input-tokens`, cache read/write, batch, flex, priority, `-mantle-` standard)                                                                                                                                                                    | The only reliable Bedrock source; already used in `calculateRequestCost.ts` for Nova and the other families. Use for refresh scripts, not at runtime                                                                                                                                                                                                            |
| Anthropic pricing page (`https://platform.claude.com/docs/en/about-claude/pricing`)                                                                                                                     | Tokens, cache multipliers, batch, fast, residency, long-context                                                                                                                                                                                                                            | Read 2026-11-10; see below                                                                                                                                                                                                                                                                                                                                      |
| OpenAI pricing page (`https://developers.openai.com/api/docs/pricing`)                                                                                                                                  | Standard, Batch, Flex, Fast, Ultrafast; short vs long context at 272K                                                                                                                                                                                                                      | Read 2026-11-10; it does not say how reasoning tokens are billed                                                                                                                                                                                                                                                                                                |
| Google (`https://aistudio.google.com/docs/pricing`, redirect from ai.google.dev)                                                                                                                        | 200K prompt tiers, "output price (including thinking tokens)", batch 50%, per-hour cache storage                                                                                                                                                                                           | Read 2026-11-10                                                                                                                                                                                                                                                                                                                                                 |
| OpenRouter `GET /api/v1/models` (`https://openrouter.ai/docs/api/api-reference/models/get-models`)                                                                                                      | `pricing.prompt`, `completion`, `input_cache_read`, `input_cache_write`, `internal_reasoning`, `request`, `image` as USD per token strings, plus `discount`                                                                                                                                | Good for the long tail, but it is a reseller's price for a routed model; per-provider endpoints differ. Use as a candidate for a refresh script, never silently at runtime                                                                                                                                                                                      |
| LiteLLM `model_prices_and_context_window.json` (`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`)                                                          | One schema for all providers: `input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`, `cache_read_input_token_cost`, `cache_creation_input_token_cost_above_1hr`, `*_batches`, `*_priority`, `*_flex`; a `sample_spec` lists `output_cost_per_reasoning_token` | Best machine-readable cross-check (3.5 MB, so not bundled). Community-maintained: a mismatch is a prompt to read the provider page, not an answer. A search-surfaced PR (LiteLLM #19704, Jan 2026) fixes cached tokens being charged in the batch path, so its calculator, not only its data, has had bugs. Not read to the end: only the first 100K characters |
| Vantage-style trackers                                                                                                                                                                                  | Billing-side attribution                                                                                                                                                                                                                                                                   | Not researched; they read invoices rather than publish a price table (see unverified)                                                                                                                                                                                                                                                                           |

Recommendation: the table in `core/llm/utils/calculateRequestCost.ts` stays authoritative. A refresh script (not in this change) diffs it against the provider page, LiteLLM's JSON and the AWS offer file and prints disagreements for a human.

## Facts the code must reflect (Anthropic page, read 2026-11-10)

- **Cache.** 5-minute write 1.25x input, 1-hour write 2x, read 0.1x; on Fable 5.1, 5.2, Mythos 5.1, 5.2 reads are 0.025x; on Opus 5.5 and Sonnet 5.5 0.05x. Matches the existing table. Fable 5 and Mythos 5 read at $1, which is 0.1x.
- **New rows.** Fable 5.2 and Mythos 5.2: $8 input, $10 5m write, $16 1h write, $0.20 read, $40 output. The table had no 5.2 rows, so they were unpriced; this change adds them with the URL and date.
- **Batch.** 50% off input and output; caching multipliers stack on top; fast mode is not available with batch.
- **Fast mode.** A premium on Fable 5.2, Opus 5.5, Opus 5 and Opus 4.8 (research preview on the last two). Stacks with caching and residency. The exact premium was not read (the page text was truncated in my extraction): treat as unverified.
- **Residency and regions.** `inference_geo: "us"` is 1.1x on every category, for Claude 4.6 and later. Bedrock and Google-managed Vertex have independent regional pricing. This agrees with the existing `us.` factor (measured on invoices), but the page now says Bedrock is priced independently, so the 1.1 for `eu.`, `apac.`, `jp.`, `au.`, `ca.` stays an assumption.
- **Long context.** Claude 4.6 and later (except Haiku 5.5) include the full 1M window at standard price. Haiku 5.5 prices each request on its own by prompt length (over 100,000 tokens, counting cache reads and writes, pays $0.50/$2.50). Already in the table as `longContext`; the loop must therefore price per request, not per aggregated total.
- **Reasoning.** Thinking tokens are billed as output (Claude Code costs page). Google: output price includes thinking. OpenAI's page is silent; the usage object's `completion_tokens` includes reasoning tokens, which is why a provider's `completionTokens` already holds them. Do not add a reasoning count on top.
- **Sonnet 5.** The $2/$10 introductory price became permanent (footnote on the page).

## Other tiers

- OpenAI: Batch and Flex about half of Standard; Fast about 2x ("Priority processing was renamed Fast mode on July 30, 2026"); Ultrafast about 6x on two models; long context above 272K input has higher rates. The existing code already returns unknown above 272K because the table carries no long rates. Keep that.
- Google: batch about 50%; priority above standard (Gemini 3.1 Pro Preview input $3.60 vs $2.00 up to 200K); flex equals batch; prompts over 200K cost more; cache storage billed per token-hour, which no per-request counter sees. Google is not priced by the product today, so it stays unknown.
- Bedrock: standard, batch, flex, priority and cross-region rows exist in the Price List. The product only meets Bedrock tiers through the service tier it requests, and does not record it in `Usage`; so the default is standard, stated.

## How other tools do it, and where they go wrong

- **Claude Code.** `/usage` (the Session block) computes the dollar figure locally from token counts at list price, per model, with a note and a `modelPricing` managed-setting override for contracted rates; multiplies by 1.1 for the data-residency rate; resets on `/clear` (since v2.1.211); `--max-budget-usd` counts the same figure; the figure is "an estimate, so for authoritative billing" use the Console. For subscribers the cost line is not billing-relevant. Known wrong, from issues surfaced by search and not verified individually: an April 2025 report that `/cost` disagreed with billing; an August 2025 report that parsing session JSONL doubled cache tokens (ccusage and similar tools that reconstruct from transcripts); the cccost author's statement that transcripts do not contain every request. The lesson: a counter fed by the request-time usage object beats one rebuilt from logs.
- **Codex CLI.** Nothing found on how it prices; unverified.
- **Cline.** A third-party comparison says Cline with your own key does not halt on cumulative cost; no bug report found. Unverified.
- **Aider.** Its FAQ shows tokens, not dollars, and states no pricing source; per-message cost is known to come from LiteLLM's table, which I did not confirm here.
- **OpenHands.** The SDK exposes `accumulated_cost` from LLM metrics, computed through LiteLLM; community notes say a model with no entry in LiteLLM's table gives zero or no cost. That is the failure to avoid: unknown treated as free.
- **LiteLLM** key-match: the model name must match the table key exactly, or the cost is zero. Same lesson.

## Unknown, local and user-priced models

| Case                                                                 | Result                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model not in any table (new release, finetune, a proxy's alias)      | `unknown`; counted tokens only                                                                                                                                           |
| Local server (Ollama, llama.cpp, LM Studio, vLLM, Strata)            | `unknown` unless the person enters a price; entering 0 is a deliberate statement                                                                                         |
| Provider known, tier or region not recorded                          | Priced at standard, in-region or global; the assumption is listed                                                                                                        |
| A long-context request the table has no rates for (OpenAI over 272K) | `unknown` for that request                                                                                                                                               |
| Mixed: some requests priced, some not                                | `unknown` for the whole slice; the UI may show "at least $X" using the priced part, as the session display already does, but a budget never enforces on a partial figure |

Why not zero for local: a zero cost would let a dollar budget "pass" silently when the run is actually on a paid proxy that is also named like a local model. An explicit setting is cheap.

## Why the loop counts from the session's per-model totals

The loop records one scalar (output plus uncached input). Cost needs the four kinds per model, and the long-context tier needs per-request prompt size. The session already keeps per-model totals by kind and the request count (`ModelUsage`). The counter takes a snapshot of those totals at each start (loop, item run) and prices the difference per model with the average request size, so a Haiku 5.5 run is priced at the long tier only when the average prompt is over the limit. That is an approximation and is listed as an assumption.

## What is built (this change)

- `costOf(usage, model, options)` in `core/util/costOf.ts`: pure; usage by kind (input not cached, output, cache read, cache write, optional 1h share, requests); returns `{ amount, breakdown, assumptions }`; delegates to `calculateRequestCost` for list prices (so there is one table), or a user price.
- Rows for Fable 5.2 and Mythos 5.2 with source URL and date.
- A cost counter: `costMark` snapshots, `costSince`, per-item `usage.cost`, per-loop total, unknown propagation.
- Enforcement of `budget: $N` for an item at the turn boundary, as `over_budget` with the work kept, only when the cost is known; otherwise the line "cost unknown for this model; dollar budget not enforced".
- Display next to tokens in the loop panel and task row.

## Not built

- A loop-wide dollar cap (`maxCostUsd`, T0) and the stop-or-ask policy (T8).
- A user-price setting in config UI; `costOf` takes the option, no field reads it yet.
- Batch, flex, fast and non-`us.` Bedrock regional pricing: standard is assumed and said.
- Google, other providers: unknown, as today.
- Refresh script against the AWS offer file, LiteLLM and OpenRouter.
- Requests outside the chat stream (title, compaction) are still not in the session totals.

## Unverified

- Fast-mode premium multiplier for Anthropic and its Bedrock availability.
- Claude Code issues named above (titles came from a search summary, not read): `/cost` versus billing (Apr 2025), JSONL doubling (Aug 2025).
- LiteLLM PR #19704 status (open or merged) and whether it affects the non-batch path.
- How Codex CLI, Cline and Aider price a request, and any cost bugs in them.
- OpenHands behaviour for models absent from LiteLLM's map (from community notes, not code).
- Whether OpenAI bills reasoning tokens inside `completion_tokens` for every model; assumed from the usage object, not stated on the pricing page.
- Bedrock geographic premiums for `eu.`, `apac.`, `jp.`, `au.`, `ca.` (only `us.` seen in billing data) and whether the 1.1x applies to batch.
- Vantage and similar trackers; the Bedrock Price List `get_products` filters; OpenRouter's `discount` field semantics.
- Whether Fable and Mythos 5.2 exist on Bedrock under the same ID pattern.
