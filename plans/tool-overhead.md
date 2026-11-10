# Tool definitions: what they cost, and loading them on demand

Status: research and first build, 2026-11-10. Companion to Q6 (a tool profile per family) in `plans/ROADMAP.md` and to the tool-list rows in `plans/prompt-caching.md`. This file does not edit either.

## 1. The question

Every request carries the tool list. It costs input tokens on every call, it sits at the very front of the cache prefix (tools, then system, then messages), and a long list makes smaller models choose worse. What does the list cost today, and is loading tools on demand worth building?

## 2. Measured (offline, deterministic, no model calls)

`core/scripts/measure-tool-overhead.mjs` runs one test in `gui` (the real `selectActiveTools` over the real `core` definitions) and one in `extensions/cli` (the real `getAllAvailableTools`). Tokens are counted with the repo's `countTokens` (the llama2 tokenizer, the repo's conservative default) and with chars/4. MCP sets are fixtures (`core/tools/toolOverheadFixtures.ts`) modelled on the filesystem, github, postgres and playwright servers: 5, 20 and 60 tools.

IDE, tokens (repo tokenizer / chars/4):

| mode | built-in only | + 5 MCP | + 20 MCP | + 60 MCP |
| --- | ---: | ---: | ---: | ---: |
| chat | 0 | 0 | 0 | 0 |
| plan (12 tools) | 2,620 / 2,671 | 3,243 | 5,042 | 8,761 |
| agent (14 tools) | 2,701 / 2,852 | 3,324 | 5,123 | 8,842 |
| agent + task list (15) | 3,156 | 3,779 | 5,578 | 9,297 |
| loop item (17) | 4,017 | 4,640 | 6,439 | 10,158 |

CLI: plan 3,229 (11 tools), agent 2,047 (10 tools); with 60 MCP tools, 9,370 and 8,188.

Findings from the numbers:

- The MCP fixtures cost about 620 tokens for 5 tools, 2,420 for 20 and 6,140 for 60: 100 to 125 tokens a tool. Real servers are heavier (Anthropic quotes about 55k tokens for a GitHub, Slack, Sentry, Grafana, Splunk setup), so these are a floor.
- Built-in tools are 2,000 to 4,000 tokens, and a few descriptions dominate. IDE: `multi_edit` 776 (582 of it description), `code_navigation` 388, `subagent` 299, `run_terminal_command` 290. CLI: `MultiEdit` 846, `AskQuestion` 330, `Bash` 279. `multi_edit` alone is a quarter to a third of the built-in cost in both. That is the cheapest saving in this document and needs no new mechanism (a shorter description is a Q6-style profile decision, to be measured, not assumed).
- Loop items cost 1,300 tokens more than agent mode because `hold_question`, `finish_item` and `remind_me` come with the `task_list` the loop owns. They are per-request, in a fresh context each item, so this is paid on every item.
- Plan mode is not cheaper than agent mode in the CLI (3,229 against 2,047) because it adds `PresentPlan` and `AskQuestion`; the IDE plan list is smaller only because it drops edit tools. Mode switches change the list, so they already break the cache (`prompt-caching.md` 4.4).
- With 60 MCP tools the list is 8,800 tokens: three times the built-ins, and 60 of 74 tools. A request pays it on every turn; at the cache-read price (0.1x) that is cheap, at the write price (1.25x) after every miss it is not.

## 3. What the platforms do (cited)

- **Anthropic tool search tool.** Stable, regex and BM25 variants (`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`), `defer_loading: true` per tool, at least one tool non-deferred, up to 10,000 deferred, 5 results by default. The docs say selection accuracy degrades past 30 to 50 tools, and give 55k tokens for a multi-server setup, reduced by over 85 percent. Every definition is still sent on every request; the deferral happens inside the API. Discovered tools arrive as `tool_reference` blocks inside the conversation, so the prefix is untouched and the cache is preserved. A custom client-side search can return `tool_reference` blocks from an ordinary tool result. Not available on the Bedrock Converse API (InvokeModel only). https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool and https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching (fetched 2026-11-10). Vendor-reported accuracy on MCP evals, relayed by third parties and not checked against the primary post: Opus 4 49 to 74 percent, Opus 4.5 79.5 to 88.1 percent (https://dev.to/rawveg/more-tools-made-ai-worse-po7, https://adilghazali.substack.com/p/anthropic-measured-the-token-problem).
- **Claude Code MCP tool search.** On automatically once MCP descriptions would exceed 10 percent of the context window; `ENABLE_TOOL_SEARCH` accepts true, false, auto, `auto:N`. Early 2026 issues report auto-activation not firing. Secondary sources only; config key names conflict. https://claudelog.com/faqs/what-is-tool-search-in-claude-code/, https://claudeissues.com/issue/18397-tool-search-doesnt-activate-automatically-despite-tengu-mcp-tool-search-flag-req
- **OpenAI.** `tool_search` in the Responses API with `defer_loading: true` on functions, namespaces or MCP servers; hosted and client execution modes; reported to need gpt-5.4 or newer; reported to inject discovered tools at the end of the context to preserve the cache. OpenAI recommends namespaces or MCP servers because models were trained to search those. Documentation reached only through mirrors: https://developers.openai.com/api/docs/guides/tools-tool-search, https://learn.microsoft.com/en-my/Azure/foundry/openai/how-to/tool-search. A forum report of a 500 with client-mode search plus a deferred tool named "web" (2026-03-06) is unconfirmed.
- **MCP client best practices.** Progressive discovery: fetch `tools/list` as usual, defer injection, give the model a `search_tools` meta-tool that returns names and one-line descriptions, load full definitions on demand. Recommended switch threshold: 1 to 5 percent of the context window. Strategies: keyword (BM25, regex), embeddings, a small-model subagent, hybrid. Figures of about 150,000 against about 2,000 tokens are illustrative. On caching it says adding or removing definitions mid-conversation invalidates the prefix and the miss can cost more than the definitions saved; append after the cache breakpoint, or route every call through one stable `call_tool({name, args})` meta-tool so the array never changes. https://modelcontextprotocol.io/docs/develop/clients/client-best-practices (fetched 2026-11-10).

## 4. Does a long list hurt quality? (mostly secondary sources)

- RAG-MCP (arXiv 2505.03275, May 2025): retrieving a tool subset more than tripled selection accuracy (43.13 percent against 13.62 percent for the baseline) and cut prompt tokens by over half on its benchmark. Figures come from summaries; one summary gives a different curve (85 percent at 5 tools, 45 percent at 20) that I could not reconcile. https://arxiv.org/html/2505.03275v1
- LongFuncEval (IBM, arXiv 2505.10570): performance drops of 7 to 85 percent as the tool count grows, for long-context models. Abstract only. https://arxiv.org/pdf/2505.10570v1
- OpenAI's function-calling guide suggests fewer than 20 functions at the start of a turn, as a soft suggestion (relayed, not checked).
- BFCL: I found no catalog-size result in its own pages; blog claims that it shows degradation are unconfirmed. ScaleMCP: the search found nothing; not cited.
- Description length: no controlled study found. Anthropic's tip is to put the keywords users use in descriptions; the MCP guidance is that one-line descriptions suffice for a catalog and full schemas for the chosen tool. Treat "shorter descriptions are better" as a hypothesis for our own eval.

The direction is consistent and the thresholds are not: 20 (OpenAI), 30 to 50 (Anthropic) and 25 to 50 (blogs) tools. For small local models I have no number, which is why the family scale in the policy is flagged unmeasured.

## 5. Cache-safe design

Tools come first in the prefix, so any change to the tool list invalidates system and messages too (Anthropic's table: "Modifying tool definitions: entire cache"). Rules this implies:

1. Stable order. The IDE already sorts MCP tools by name after built-ins (`stableToolOrder`); the CLI did not (it used connection order). The policy sorts.
2. Never change the list for convenience mid-session: no per-turn filtering by relevance.
3. A deferred set decided by a token budget is a function of the tool set alone, so it does not move between turns.
4. Activation has a cost this build does not avoid: appending a found tool to `tools` rewrites the prefix once. Anthropic's hosted search avoids it by putting the definition in a message (`tool_reference`). Two ways to get that on a client: (a) the single stable `call_tool` meta-tool, with the found tool's schema in the search result text (no list change ever, but the model calls through an indirection and loses native schema validation and per-tool permission display); (b) provider-native search on Anthropic and OpenAI where the path supports it (not Bedrock Converse). Neither is built.
5. Per-tool approval must follow the real tool name, not `call_tool`, if (a) is ever built.

## 6. Decision

- Build the policy and the client-side `search_tools`, off by default, engaged only above a budget. Done in this change. The budget default is 4,000 tokens (2 percent of 200K, inside the MCP guidance of 1 to 5 percent, between the 20- and 60-tool fixtures); half for small-model families (unmeasured).
- Do not turn it on by default until a quality run (P2/P3 style) shows tool-choice accuracy not falling with search on, and a cache replay shows the activation miss is paid back. Both need live models and were out of scope.
- Next, cheapest first: (1) shorten `multi_edit` and `code_navigation` descriptions behind a profile (Q6); (2) a `call_tool` variant if the miss per activation turns out to matter; (3) prefer provider-native search for Anthropic direct and OpenAI; (4) a hybrid (BM25 plus embeddings) index if keyword search misses in practice.

## 7. What is built (this change)

- `core/tools/toolSearch.ts`: `selectTools`, search index, result format, `toolSearch: off|auto`.
- `search_tools` (IDE) and `SearchTools` (CLI) meta-tools; the IDE tool runs in core, the CLI tool in the CLI.
- Wiring: IDE in `buildChatRequest` (via `applyToolSearch`), the CLI at the end of `getAllAvailableTools`. Setting: `experimental.toolSearch` in the user config (IDE), `CONTINUE_TOOL_SEARCH=auto` (CLI).
- Measurement script and tests. Off is asserted identical to today's list (same array in the IDE; same JSON in the CLI); auto is asserted equal under the budget and engaged above it.

## 8. Unverified

- All accuracy figures in section 3 and 4 are second-hand or from abstracts.
- The Claude Code threshold (10 percent) and env var names are from third-party pages.
- OpenAI's model support and cache behaviour come from mirrors and a search summary.
- The family scale (0.5) and the 4,000 budget are proposals.
- The fixtures are modelled, not copied; real servers cost more per tool.
- Whether activation by append costs more cache than it saves was not measured.
- Disabled tools: the IDE search tool cannot see GUI tool policies, so it can return a tool the person disabled (the next request still leaves it out).
