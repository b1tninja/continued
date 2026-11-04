# Plan: cache features from real-world data (C14 to C19)

Status: planned, nothing built. Written 2026-11-03 against `feat/cache-countdown`. Evidence:
[`cache-real-world-data.md`](./cache-real-world-data.md). The Auto lifetime changes (C11a to C13) are in
[`cache-adaptive-lifetime.md`](./cache-adaptive-lifetime.md) and are not repeated here.

## Summary

A week of real agent traffic says caching is worth far more than any lifetime tuning, and that the Auto
lifetime is already close to the best achievable. What is left is accuracy and reach: price the Bedrock
regional premium, show what lost caches cost, bring the policy to the CLI, and only then change the default.

Six features. C14 is small and independent. C17 is small and reuses the miss detector. C15 is a billing default
the owner decides. C16 and C18 each need a check before they can be sized. C19 needs Continue's own data
first, so it is a placeholder with a test, not a build.

## What the data supports

| Finding                                                     | Number                                                                                   | Feature                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Caching against no caching, same tokens                     | about 85% cheaper (upper bound)                                                          | C15, C16                                              |
| A write pays for itself after this many later reads         | about 0.3 (0.26 at the billed rates)                                                     | C15                                                   |
| Single-call conversations                                   | 20% of conversations, under 1% of cost                                                   | C15                                                   |
| Input-side cost spent re-reading prefixes the cache lost    | 39%, of which 34 points follow gaps of 5 minutes or more                                 | C17                                                   |
| Writes above a session's peak context, by session age       | 14% under 15 min, 84% for 4 to 24 h, 93% over 24 h                                       | C19                                                   |
| Claude on Bedrock `us.` profiles, billed against list price | 1.10 times, on every component                                                           | C14                                                   |
| OpenAI models on Bedrock: hit rate by gap                   | 93% to 97% to 10 min, 77% to 83% at 20 to 30 min, about 10% from 30 min                  | C18                                                   |
| A tool with a poor request shape                            | 15% of input uncached, about twice the input cost of the same traffic at the typical mix | none; C13 shows whether Continue has the same problem |
| Hit rate inside the lifetime                                | 98.6% to 99.1% in each of four weeks                                                     | no work                                               |
| Per-person tuning from history; keepalive pings             | +0.2%; -1.3% at best                                                                     | not building                                          |

## Features

### C14: Bedrock regional price factor

Claude models on Bedrock `us.` inference profiles were billed at 1.10 times Anthropic's list price on
input, output, cache reads and both write lifetimes. The cost table uses list prices, so every dollar
figure the app shows for those models, including the notices, is about 9% low. Anthropic's pricing page
says regional and multi-region endpoints carry a 10% premium over global endpoints for Claude 4.5 and later.

- `calculateRequestCost(provider, model, usage)` calls `calculateAnthropicCost`, which calls
  `findAnthropicPricing`, which calls `normalizeClaudeModelId`. That function drops everything before
  `claude`, so the `us.` prefix is gone before the price lookup. Read the prefix first, then normalise.
- Factor 1.10 for `us.`; 1.0 for `global.` and for IDs with no prefix. Applies to every component, including
  Haiku 5.5's higher price above 100,000 tokens (billed long-tier rates were list times 1.10).
- The Bedrock provider also prefixes a bare model ID at request time from `env.crossRegionInference`
  (`applyCrossRegionInference`). The factor needs that setting when the configured ID has no prefix.
- Tooltips that quote a figure say when the factor was applied. The existing "estimated" label stays.
- Not confirmed: `eu.` and `apac.` factors, and whether a `global.` profile really bills at list. Apply the
  factor to `us.` only, which is what was measured, until an AWS price list or a billing line says more.
- Tests: table-driven by prefix and component; the long tier; a bare ID with `crossRegionInference` set.
- Risk: low. Depends on: nothing.
- Built on `feat/bedrock-us-price-factor` (`10a7ee46f` in the fork, stacked on the countdown branch).
  `findAnthropicPricing` applies the factor, so the notices and the usage panel get it, and so does any other
  caller whose model ID starts with `us.anthropic.`. The breakdown says when it was applied. 784 GUI tests and
  the 97 cost tests pass; it was not checked in a running UI.

### C15: caching on by default in agent-style modes

C4 is a billing default and the owner's decision. The data supports a narrower version than "on for all
Claude use": on in Agent, Plan and Background when the config says nothing; Chat unchanged.

- Why not Chat: the first write costs 25% more than plain input and pays for itself on the first later
  request that reads it (break-even 0.26 of a read). A tool loop makes that second request nearly certain. A
  one-shot chat question never makes it, and no data here says how often chat users follow up.
- An explicit `promptCaching: false` in config stays off. An explicit toolbar choice wins over everything.
- `resolvePromptCache` computes `cachingOn` from the toolbar setting or `configEnablesPromptCaching`. With
  no setting and no config, return `promptCaching: true` plus the Auto lifetime when `mode` is agent-style.
  `promptCacheStatus` must agree, or the toolbar icon and the request will disagree.
- The caching-off notice (`CachingOffNotice`) currently fires on a long conversation with caching off. With
  the default, it only shows in Chat or when the user turned caching off. Check its tests.
- Docs: `prompt-caching.mdx` lists "Caching on by default" under "Not supported". Change it.
- Release note says the first request of a session costs more, and where the switch is.
- Tests: the mode matrix against setting and config; the status and the request option agree; the notice.
- Risk: medium (billing). Depends on: C11a, C11b, and a week of C13 data from Continue's own Agent use.

### C16: the CLI and the shared adapters

Checked in the code on `feat/cache-countdown`; nothing run.

- The CLI builds its model client with `constructLlmApi` from `packages/openai-adapters`, which does not
  import `core`. The GUI path (`core/llm/llms/Anthropic.ts`, `Bedrock.ts`) is a different implementation.
  Everything in C2 to C13 is in `core` and the GUI, so none of it reaches the CLI.
- Anthropic adapter: caching is on unless `cachingStrategy` is `none`. The default strategy
  (`systemAndTools`) marks the system prompt, the tools and the last two user messages with
  `cache_control: { type: "ephemeral" }`. No `ttl` is ever sent, so the CLI is always on the 5-minute lifetime.
- Bedrock adapter (`BedrockApi`): the cache points are commented out (`_addCachingToLastTwoUserMessages` is
  never called, and the system block is `false ? ... : ...`). It sends no cache points at all. A CLI user on
  Bedrock gets no prompt caching, and `cacheBehavior` is not in the adapter's Bedrock schema (also commented out).
- The Bedrock adapter reads no usage at all. A search of `Bedrock.ts` for `usage`, `metadata`, `inputTokens`
  and the cache token fields finds only `usage: undefined` in the non-streaming reply and the embedding and
  rerank replies. The Converse stream's `metadata` event, which carries the token counts and the cache read
  and write counts, is never handled. So a CLI session on Bedrock cannot show tokens, cost or cache hits, and
  `streamChatResponse.helpers.ts` falls back to its estimate. That is a code reading; it was not run.

Before sizing: the live run is still worth a few cents, but it can now only confirm what the code says: no
cache points go out and no usage comes back. If so, this is the largest finding in the plan. The data says
caching saves about 85% of input-side cost, and a Bedrock CLI session gets none of it and cannot even see it.

Proposed, in this order, each its own PR:

1. **Done** (`feat/bedrock-adapter-usage`, `347d17f6c`, local, branched from the countdown commit). The Bedrock adapter handles the stream's `metadata` event and maps token counts and cache read and write
   counts into `usage`. This comes first: without it nothing else in the CLI can be measured or priced.
2. The Bedrock adapter sends `cachePoint` on the system block, the tools and the last two user messages,
   behind the same `promptCaching` setting the GUI honours, defaulting off until the live test passes.
3. Both adapters accept a lifetime (`5m` or `1h`) and send it as `ttl`. `core` already has the Bedrock
   allowlist (`bedrockSupportsOneHourCache`); the adapters cannot import `core`, so move it somewhere both can.
4. The CLI applies the Auto rule (C11a and C11b) from its own request count and the gap between requests.
   The CLI has no toolbar, so the setting comes from config and a flag.

Tests: request-body tests in the adapters (there is a `Bedrock.vitest.ts`), the shared allowlist, and a CLI
test with a mocked client. Live: a few cents on Bedrock, as for the GUI.
Risk: low for step 1 (reads a field that is already sent); medium for step 2 (turns on billing behaviour for
CLI Bedrock users); low for step 3.
Depends on: the live check above.

### C17: show what lost caches cost

C10 asked for a "spent on cold rewrites" line in the usage panel. The data gives it a definition.

- Re-read cost of a request = tokens the previous request cached but this one did not read, times the
  5-minute write price minus the read price. Over a week of all requests this was 39% of input-side cost: 34
  points after a gap of 5 minutes or more and 5 points from prompt edits, compaction and tool changes. Show
  the two parts separately.
- `detectCacheMiss` and the session's `lastInputTokens` already give the lost prefix per request. The usage
  panel (`TotalUsage.tsx`) already shows cache read, cache write and a hit rate. Add one line: "Re-read after
  a cold cache: N tokens, about $X over the session", with the split in the tooltip.
- Prices come from the same table as the notices, so C14 applies. Label the figure "estimated".
- Not a notice: the existing notices warn before the cost. This is a look back, in the panel only.
- Tests: the sum over a recorded sequence of requests; a session with no misses shows nothing.
- Risk: low. Depends on: C14 for the amount, C6 for the detector.

### C18: models that cache by themselves

In the Bedrock data, OpenAI models bill cache writes as a "30m" usage type. Their hit rate is 93% to 97% out
to 10 minutes, 77% to 83% between 20 and 30 minutes, and about 10% from 30 minutes. That fits a 30-minute
lifetime. It is a reading of the pattern, not something the provider documents here.

- `modelSupportsPromptCacheControl` is true only for Claude on Anthropic and Bedrock, so the toolbar button,
  the countdown and the cold-cache notices are hidden for these models even though their caches expire and a
  pause past 30 minutes costs a full rewrite.
- Proposed: a read-only status for models that cache automatically. The countdown ring runs from a 30-minute
  lifetime and the tooltip says the provider manages it and there is nothing to set.
- Check first: the provider's documentation for the lifetime, and whether a request through Continue to
  these models returns cache read and write tokens at all. If not, there is nothing to show.
- Risk: low. Depends on: the check.

### C19: long sessions

Sessions open for more than 12 hours were 62% of spend. The share of written tokens above a session's peak
context rose with age: 14% under 15 minutes, 84% for 4 to 24 hours, 93% over a day. That is a cold cache
rebuilt many times, or a context that keeps growing.

- Today the cold-cache notice offers to compact after a pause and the context meter shows size. Neither
  looks at how long the session has lived.
- Proposed, once C13 has Continue's own data: when a session is both old and has had several cold rewrites,
  offer a fresh session with a summary and the expected saving. Not before: the thresholds would be guesses,
  and the data is other tools' sessions.
- A placeholder with an entry condition. Build C13 first.
- Risk: low. Depends on: C13 and a week of data from our own use.

## Order

| Order | Feature         | Why here                                                         |
| ----- | --------------- | ---------------------------------------------------------------- |
| 1     | C14             | Small, independent, makes every dollar figure honest             |
| 2     | C16 check       | A few cents of live testing; may be the largest finding          |
| 3     | C11a, C11b, C13 | In the adaptive plan; C13 produces the data C15 and C19 wait for |
| 4     | C17             | Reuses the detector, needs C14                                   |
| 5     | C16 build       | Sized after the check                                            |
| 6     | C15             | After a week of C13 data from Continue's own Agent use           |
| 7     | C18, C19        | Each waits on a check or on data                                 |

## Not building

- Per-person tuning from history: no gain on 3.5 weeks of data (+0.2%).
- Keepalive pings: -1.3% at best for 71,000 extra requests, and a read refreshing the lifetime is unmeasured.
- A context-size trigger for the 1-hour lifetime: weaker than the request count (-1.8% against -3.8%).
- Tuning the 5 to 55 minute window: moving the upper bound changes the total by under 0.2%.
- Anything that depends on knowing who the user is. The data is other people's tools.

## Open questions

| Question                                                                    | How to settle it                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Does the CLI on Bedrock cache at all?                                       | Run it once and read the cache tokens (the C16 check)               |
| Do the thresholds hold for Continue's own users?                            | C13, a week of our own Agent use, then Chat                         |
| What is the right factor for `eu.`, `apac.` and `global.` Bedrock profiles? | An AWS price list, or a billing line per profile                    |
| Does the cache count from the start of a request or its end?                | A live test with a response long enough to tell; the logs could not |
| Is caching on by default acceptable to whoever owns the billing?            | The owner's call (C15); this plan only says what the data supports  |
