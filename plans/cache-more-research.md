# Research notes: what other tools and vendors do that we do not (second pass)

Read on 2026-11-04. These are documentation reads and code reads, not live tests. Each item says what the
source says, what Continue does now (checked in the fork's code), and what that suggests. Items are numbered
C23 onward in `ROADMAP.md`. Nothing here is built.

## Sources and what they add

| Source                                      | What it says                                                                                                                                                                                                                                                                                                                                                                                                                                | Continue now                                                                                                                                                                                                  | Suggests |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Anthropic, cache diagnostics                | Pass the previous response `id` as `diagnostics.previous_message_id` and the response says where the two requests diverged: `model_changed`, `system_changed`, `tools_changed`, `messages_changed`, with `cache_missed_input_tokens`. "Claude API only: Not available on ... Amazon Bedrock."                                                                                                                                               | Our miss detector hashes model, tools and system itself (`keyChanges`). It has no `messages_changed`: an edited or truncated history is only caught as "the prompt got shorter".                              | C23      |
| Claude Code, `/usage`                       | A "Prompt cache" line: requests, share of input from cache, misses (time of the last, tokens re-cached), "expected rebuilds" (its own compaction or tool-result clearing), and warm or cold with the TTL. "The counts come from the cache token fields in the API's responses, so the line works on every provider."                                                                                                                        | The ring and tooltip show warm or cold. The ledger (C22) holds everything the line needs, but nothing summarises it.                                                                                          | C24      |
| Claude Code, engineering notes and docs     | Run compaction with the parent's exact prefix so it reads the cache. Compaction is a cache-invalidating event it counts separately.                                                                                                                                                                                                                                                                                                         | `compactConversation` sends the history and the summary prompt with no system message and no tools, so its prefix cannot match the conversation's.                                                            | C25      |
| Anthropic, mid-conversation system messages | Available on Amazon Bedrock, on Fable and Mythos, Opus 4.8, 5 and 5.5, Sonnet 5.5, Haiku 5.5. "This feature is not available on Claude Sonnet 5." Sonnet 5.5 and Haiku 5.5 "can treat a system message placed right after a tool result as untrusted text and ignore it". Tool changes by reference (`mid-conversation-tool-changes-2026-07-01`) work on Bedrock; defining a tool inline (`inline-tools-2026-09-15`) does not list Bedrock. | C8 lists four models and does not mention either caveat.                                                                                                                                                      | C26      |
| OpenAI, prompt caching                      | Before GPT-5.6, a stable `prompt_cache_key` routes related requests to one cache ("aim for about 15 requests per minute" per key). GPT-5.6 and later route automatically. Retention: `in_memory` (about 5 to 10 minutes, up to an hour) or `24h`; on GPT-5.6 and later `prompt_cache_options.ttl`.                                                                                                                                          | The adapter forwards a `prompt_cache_key` if given, but nothing sets one.                                                                                                                                     | C27      |
| Google, Gemini context caching              | Implicit caching is on by default for Gemini 2.5 and later; minimum 2,048 tokens (2.5) or 4,096 (3.x and 4). On Gemini 4 the full previous request is cached only if the new one adds at least 2,050 tokens. Hits are reported in `usage.total_cached_tokens`.                                                                                                                                                                              | The types carry `cachedContentTokenCount`; `packages/openai-adapters/src/apis/Gemini.ts` maps `promptTokenCount`, `candidatesTokenCount` and `totalTokenCount` and nothing else, so a cache hit is invisible. | C28      |
| Claude Code, lifetimes                      | It decides the lifetime per request in two buckets: the main conversation, and "everything else" (subagents, compaction, titles), which stays at 5 minutes by default.                                                                                                                                                                                                                                                                      | One policy for the conversation. Subagents (beta in the CLI) were not checked.                                                                                                                                | C29      |
| Anthropic, prompt caching                   | "A cache entry only becomes available after the first response starts." For parallel requests, wait for the first response.                                                                                                                                                                                                                                                                                                                 | Not checked for parallel tool calls or subagents.                                                                                                                                                             | C29      |
| Claude Code, hooks and status line          | A `PreModelSwitch` hook can confirm or block a model switch; a `prompt_cache` object is exposed to status line scripts.                                                                                                                                                                                                                                                                                                                     | Hooks D1 to D3 are wired; no cache-related event.                                                                                                                                                             | C30      |
| Aider, caching                              | `--cache-keepalive-pings N` pings every 5 minutes, up to N times after each message.                                                                                                                                                                                                                                                                                                                                                        | Deferred (a gain of 1.3% at best in our data).                                                                                                                                                                | none     |

What the research confirmed and did not change: Claude Code's list of actions that break the cache (model
switch, effort change, fast mode, MCP server or plugin changes, denying a tool, compaction, many images) is
mostly what `useWarmCacheNote` and the switch notices already cover. One nuance: on Opus 5.5, Sonnet 5.5, Haiku
5.5 and Fable 5.1 with an API key, changing effort keeps the cache; on Bedrock it does not.

## Proposed items

Sized small (a day or less), medium (a few days) or large. Each names what to check before building. None is
built.

### C23: add a `messages changed` cause to the miss detector (small)

Anthropic's diagnostics distinguishes four causes. Ours reports model, tools and system, and treats a shorter
prompt as "history was cut" without saying so as a cause. A `messages_changed` cause (a message earlier than
the newest was edited, reordered or removed) is the one a user can act on: it usually means an edit or a
regenerate. Hash each message the way `promptCacheKey` hashes the system prompt, keep the list in the key, and
report the first index that differs.

- Not available from the API on Bedrock, so this stays a local check and cannot be replaced by the server.
- Check first: whether regenerating a reply or editing an earlier message changes the bytes we send, and
  whether the per-process ID on the first user message (Bedrock) makes the first message's hash differ.
- Tests: edit, regenerate, delete, compaction (should say compaction, not a fault), pruning.

### C24: a one-line cache summary in the usage panel (small)

Claude Code shows requests, hit share, misses with the time of the last and tokens re-cached, expected
rebuilds, and warm or cold with the TTL. Every number is already in the C22 ledger. This also gives C17 (cost
of lost caches) somewhere to live. Treat compaction and a model switch the user chose as "expected rebuilds",
as Claude Code does, so they are not counted against the cache.

- Check first: that the ledger's miss causes separate an expected rebuild from a fault; today `missCauses`
  holds the cause text only.
- Tests: a recorded ledger with a miss, a compaction and a switch gives the right counts; no ledger gives no line.

### C25: make compaction read the cache (medium)

`compactConversation` (`core/util/conversationCompaction.ts`) sends the history plus the summary prompt with
no system prompt, no tools, and an empty options object, so it passes no `promptCaching` at all. Unless the
model's config turns caching on, the request has no cache points: it neither reads the conversation's cache
nor writes one, and pays the full input price on a conversation that is, by definition, large. Even with
caching on in config, its prefix (no system prompt, no tools) cannot match the conversation's. Anthropic's
own tool sends the parent's exact prefix. Sending the same system prompt and tool list, with the summary
request as the final user message and the conversation's cache setting, should read the cache the
conversation already has.

- Check first, live: how many tokens a real compaction reads and writes today against the same request
  with the parent's prefix. This is the measurement that decides it, a few cents on Bedrock.
- Risk: tools in the request mean the model may try to call one instead of summarising; the request needs
  `toolChoice` none or an instruction, and the result must be text only.
- Depends on: C16 for the CLI path; the GUI path is `core/util/conversationCompaction.ts`.

### C26: add the caveats to C8 before building it (small, docs only)

C8 plans to send rule changes as an appended system message. The documentation adds three constraints that
change the plan: it is not available on Sonnet 5 even though Sonnet 5.5 has it; Sonnet 5.5 and Haiku 5.5 may
ignore a system message placed right after a tool result, so the instruction should go in the user turn on
those models; and a system message cannot be the first entry. Update C8 with these and a per-model table
before anyone writes code.

### C27: OpenAI cache key and retention (small)

Before GPT-5.6, a stable `prompt_cache_key` per conversation helps route requests to one cache; the adapter
forwards one but nothing sets it. For GPT-5.6 and later OpenAI routes automatically and the key is not needed.
A conversation ID is a reasonable key, with the privacy note from OpenAI that separate keys also prevent
cache-hit probing across users. Retention (`prompt_cache_retention`, or `prompt_cache_options.ttl` on 5.6
and later) has no setting at all.

- Check first: that setting a key does not change behaviour on models that ignore it, with one live request
  on a direct OpenAI key (not Bedrock, where the adapter is different).
- Not for Bedrock: OpenAI models there cache implicitly and Converse takes no key.

### C28: read cached tokens for Gemini (small)

Gemini caches implicitly from 2,048 tokens (2.5) or 4,096 (newer) and reports hits in
`usageMetadata.cachedContentTokenCount`. The type exists in the repo and nothing maps it into `Usage`: the adapter
(`packages/openai-adapters/src/apis/Gemini.ts`) reads the three plain counts, and `core/llm/llms/Gemini.ts` has no
usage handling that a search found, so a Gemini user sees no usage, hit rate or cost saving at all. Map it into `promptTokensDetails.cachedTokens`, and add the
minimum to `cacheMinimums.ts` so the status can say "nothing cached yet".

- Check first: whether Gemini's prompt count includes the cached tokens (it does in OpenAI's convention), so
  `promptTokensExcludeCache` must say false for it. A wrong answer double counts.
- Prices are not in the cost table for Gemini; the hit rate is useful without them.

### C29: lifetime per kind of request (medium)

Claude Code picks a lifetime per request in two buckets: the main conversation, and everything else
(subagents, compaction, titles), which stays at 5 minutes. A subagent or a title request that inherits the
conversation's 1-hour setting pays the 2x write for an entry that is read once. Also, "a cache entry only
becomes available after the first response starts": parallel subagents that share a prefix will each write it.

- Checked: title generation (`core/util/chatDescriber.ts`) calls `model.chat` with the model's own options, so it
  caches only if the model's config does, and it would take the conversation's lifetime if one were set there.
- Check first: what subagents send today (`tools/subagent.ts`, `subagent/executor.ts` were not read).
- Depends on: F6 (subtasks) for the design; the title and compaction requests can be done on their own.

### C30: cache events for hooks and a script-readable summary (medium, later)

Claude Code exposes a `PreModelSwitch` hook and a `prompt_cache` object for status-line scripts. Our hooks
(D1 to D3) have no cache event. A `PreModelSwitch` hook is small once the model switch has a single point; the
summary object is the C24 data in JSON. Lower priority than C23 to C25 because it serves a few users.

## Order

| Order | Item     | Why                                                                             |
| ----- | -------- | ------------------------------------------------------------------------------- |
| 1     | C26      | Docs only, and it prevents building C8 wrong                                    |
| 2     | C23, C24 | Small, local, and C24 is where C17 lands                                        |
| 3     | C25      | The only item here with a likely large saving; needs one live measurement first |
| 4     | C28, C27 | Reach people on other providers; each needs one check                           |
| 5     | C29      | Needs the subagent code read first                                              |
| 6     | C30      | Later                                                                           |

## Not worth doing, and why

- **Keepalive pings** (Aider's `--cache-keepalive-pings`): still 1.3% at best for a large number of extra
  requests in our data; Aider's own docs note the cost is paid on every ping.
- **Anthropic cache diagnostics as a feature:** it is Claude API only, not Bedrock, and Bedrock is the
  provider this fork is built around. C23 does the useful part locally.
- **Explicit `prompt_cache_breakpoint` for GPT:** AWS says Converse does not support it for these models.
