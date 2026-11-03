# Cache and cost safeguards

Which expensive mistakes the app can warn about, what it says, what it offers instead, and what is built. Companion to [`prompt-caching.md`](./prompt-caching.md).

## Rules for a warning

- Say nothing on the fast path. Most requests follow the previous one within two minutes.
- Warn before the money is spent, while the user can still choose.
- Name the cost in tokens and, when the model is priced, dollars. Say what each offered action costs, including that compacting reads the whole conversation once at full price.
- One dismissible line, never a dialog, except for a model switch, which is a deliberate act.
- Offer the cheaper way: a new session, compaction, or a longer cache lifetime.
- Every threshold is a constant in `gui/src/util/cacheSafeguards.ts` so it can be tuned from real use.

## Evidence

- **Documented**: Anthropic's pages on [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), and Claude Code's [prompt caching](https://code.claude.com/docs/en/prompt-caching) and [cost](https://code.claude.com/docs/en/costs) pages, read 2026-11-03.
- **Measured**: a one-off, by-hand look at one developer's request timelines from two other coding agents, plus an AWS account's billing and CloudWatch data. The scripts are not in this repository and Continue never reads another tool's history. One developer with unusually long sessions (contexts to 1M tokens), so use the numbers to pick thresholds, not as typical frequencies.

Measured findings:

1. Pauses are short. The median gap between requests is 13 to 15 s and 92% of gaps are under 2 minutes. Gaps of 5 to 55 minutes are about 3%.
2. Auto and always-1h cost about the same (replayed cost 18.4% and 18.6% below 5-minute writes). Whether caching is on matters far more: no cache cost 7 to 9 times the 5-minute replay.
3. Context size is the cost. Requests over 200k tokens were 81% of one agent's requests and 90% of its cost.
4. Cold resumes onto a 50k+ context carried 10 to 13% of billed cost. For the agent that wrote 5-minute entries, 70% of that came from pauses of 5 to 15 minutes, which a 1-hour cache covers.
5. Some misses are tool bugs: one agent left over 10k tokens uncached on 74% of in-window requests, and on 79% of the ones started by a tool result.
6. Compacting at a cold resume beat continuing in 90 to 100% of cases, but the saving comes from the later messages. The compaction request itself reads the whole conversation.
7. A notice per large tool result would fire 14 times a day for 8% of context growth. Not worth it.
8. On Bedrock, a Regional ("us.") profile bills 10% above the global one for the same model: Cost Explorer shows $2.00 and $2.20 per million input tokens for Sonnet 5.5.

Documented, and matching the billing: Claude Haiku 5.5 is priced by prompt length. A request over 100,000 tokens (cache reads and writes included) pays 5 times the input, output, read and write prices on every token of that request. 97% of one account's Haiku 5.5 cost sat in `long_ctx` usage types.

## Gotchas

| # | Gotcha | What the user sees | Offers | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Cache expired, large conversation, next message re-reads it | Line above the input: "Prompt cache expired 12 min ago. Sending re-reads 366k tokens at full price (about $1.26 more)." | Compact first, New session, Use 1 hour cache, Dismiss | Documented, measured | Built |
| 2 | Switching model starts an empty cache | Confirmation naming both models and the cost, only above $0.25 | Switch anyway, Switch in a new session, Cancel | Documented | Built |
| 3 | Switching mode changes the system prompt and tools | One line in the mode menu while the cache is warm | informs | Documented | Built |
| 4 | Toggling reasoning rebuilds the message cache | Added to the reasoning button's tooltip while warm | informs | Documented | Built |
| 5 | The cache keeps missing | After 3 misses: "The prompt cache missed 3 times in this session. The last request read 0 of 112k tokens." Names the model, tools or system prompt when one changed | Dismiss | Measured | Built |
| 6 | A big conversation costs a lot per message | Context meter appears at 200k tokens, not 60% of the window; tooltip gives the cost of one more message warm and cold | Compact, New session | Measured | Built |
| 7 | Haiku 5.5 charges 5x above 100k tokens | Meter appears at 80k; tooltip gives the multiplier and the size | Compact, New session | Documented | Built |
| 8 | Claude 5 and 5.5 had no prices | Dollar amounts now shown for them | none | Documented | Built |

## Built

- `core/llm/utils/calculateRequestCost.ts`: Opus 5, Opus 5.5, Sonnet 5, Sonnet 5.5 and Haiku 5.5; cache reads at 0.05x on the two 5.5 models; Haiku 5.5's long-prompt tier. A later minor version (`claude-sonnet-5-6`) no longer matches an earlier entry's price and stays unpriced until added.
- `gui/src/util/cacheSafeguards.ts`: the rules and thresholds (`coldResume`, `warmCacheLoss`, `detectCacheMiss`, `promptCacheKey`). `cacheNotices.ts`: wording helpers.
- Components: `ColdCacheNotice`, `CacheMissNotice`, `NoticeBar`, `ModelSwitchConfirm`, `ModeSwitchCacheNotice`, and changes to `ModelSelect`, `ContextStatus` and `InputToolbar`.
- A new or loaded session now starts with an empty cache record. Before, it kept the previous session's.

## Not built

Also on [`ROADMAP.md`](./ROADMAP.md) under Track C.

- **Resuming a saved session.** The biggest cold resume has no notice, because a loaded session has no recorded size. Needs the size from stored usage or an estimate.
- **Caching on by default for Claude** (C4). A billing default; the owner decides.
- **Rules that change the system prompt mid-session.** Rules matched against the latest tool output are written into the system prompt, so a match rebuilds the whole cache. Opus 4.8, Sonnet 5.5, Opus 5.5 and Haiku 5.5 accept a system message appended to the conversation instead, which keeps the cache. The miss notice already names "the system prompt" when this happens.
- **Images, tools and MCP servers while the cache is warm.** Documented to rebuild the cache. Warn on attaching an image, or toggling a tool or server, in a large warm conversation.
- **Global versus Regional Bedrock profile.** A hint in the Bedrock setup, not a warning, since Regional may be required for data residency.
- **Tool result clearing.** Context editing drops old tool results server-side, but each clearing rebuilds the cache, so it needs a minimum amount per clearing. Evaluate before offering.
- **Large attachments and pasted files.** The measured jumps of 100k+ tokens are unexplained. Warn before sending, from the token count of the message, once Continue has its own data.
- **Quality, not only cost.** Anthropic documents that accuracy and recall fall as context grows. Add a line to the meter tooltip and consider suggesting a new session between unrelated tasks.
- **Session cost in the toolbar** and a "spent on cold rewrites" line in the usage panel.
- **Guesses worth testing first**: suggest a new session after two rejected edits in a row; suggest a smaller model for a short, simple prompt.

## Limits

- Not clicked through in a real editor. Tests cover logic and rendering in jsdom.
- Changing model, tools or the system prompt makes the next requests count as misses. The notice names the cause, but if it proves noisy, count only misses with no known cause.
- The Anthropic-path breakpoints on tool results are tested with mocks only. The Bedrock path had one live run.
- Prices are list prices. A Regional Bedrock profile bills 10% more, so Bedrock figures for those models read about 10% low.
