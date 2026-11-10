# Track V research: memory, session history and ageing

Status, 2026-11-10: research plan. Built so far, not wired into any request path: `core/util/contextAgeing.ts` (row VA1, the masking function) and `core/util/cacheReplay.ts` with `npm run replay:ageing` (row V0b, offline half). Nothing else here is built. The replay table on the synthetic session shows only that the harness runs; it is not evidence for any default.

Date: 2026-11-10. Read-only research against `origin/main` of b1tninja/continuous (fetched today). Web sources are cited with the access date 2026-11-10 unless stated. Anything not read first-hand is in the unverified list at the end.

## 1. Decision summary

1. Track V as written (V0 to V8) is about **process memory, DOM and disk**, and it forbids ageing inside the context window (D3). Nothing in the repo ages **what the model is sent** other than overflow truncation and whole-conversation compaction. These are two different problems and the plan should say so in its first paragraph. Recommend splitting: V = footprint (as planned), a new **V-A = request-side ageing** (below), and a **memory panel** that covers both.
2. Evidence says request-side ageing should start with **masking old tool results** (a placeholder, not a summary), keep summarisation as the fallback, and be triggered **in batches, rarely**. Batching is the only way it coexists with prompt caching: every edit to old content rewrites the cached prefix.
3. Ageing must never be silent. Each ageing event is a **planned cache rebuild**, shown as a note with a token estimate before it happens when the cache is warm, and recorded in the cache ledger the way C31 already records compaction.
4. Durable memory should stay **plain files the person owns** (AGENTS.md / rules already exist), with an optional, off-by-default, model-writable memory directory and a panel to review it. No vector store, no telemetry, no hosted service.
5. Build V0 first, and extend V0 to **replay recorded histories** and score ageing policies on tokens, cache reads and task success. Every default below is a hypothesis until V0 runs.

## 2. What we have today

All paths on `origin/main`.

**Request-side (what the model sees)**

- `core/llm/countTokens.ts` `compileChatMessages` (line 426 on): when the request exceeds the budget it removes messages from the middle (`historyWithTokens.splice`, ~line 550, `didPrune = true`), protecting a tail and the task-list block (`util/taskPlan.ts`). This rewrites the prefix at an arbitrary point with no notice to the person beyond the ledger's "expected rebuild" (C31).
- `core/util/conversationCompaction.ts` `compactConversation`: LLM summary of history up to an index, stored as `conversationSummary` on a history item. While the cache is warm it sends the chat's own compiled request plus the summary prompt (`conversationPrefix`), so the summary call reads the cache (row C25, built, #261). `core.ts:1353` passes the prefix.
- CLI: `extensions/cli/src/compaction.ts` (`compactChatHistory`, `shouldAutoCompact`, `AUTO_COMPACT_BUFFER_CAP` 15,000, ratio 0.8), `stream/streamChatResponse.autoCompaction.ts`, `/compact` in `commands/chat.ts`, `ChatHistoryService.compact` / `getHistoryForLLM(compactionIndex)`. The CLI prompt differs from the core prompt (two summary prompts to keep consistent).
- Tool output caps at the source: CLI `util/truncateOutput.ts`, `CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS`, `tools/readFile.ts`. IDE terminal path unchecked (plan says so).
- No tool-result clearing or masking exists. ROADMAP C10 ("Evaluate tool result clearing and compaction suggestions on Continue's own data") is **Open**, depends on C6.
- Task list is kept outside the transcript and re-sent each request (`util/taskPlan.ts`), so it already survives compaction. This is the one existing "memory outside the history".

**Durable instructions**

- Rules and agent files: `core/config/markdown/loadMarkdownRules.ts` (`SUPPORTED_AGENT_FILES` AGENTS.md, AGENT.md, CLAUDE.md), CLI `instructionFiles.ts` (adds CODEX.md), `environmentContext.ts` (puts volatile text away from the cached prefix). `/init` writes AGENTS.md (`commands/init.ts`). Rules matched against tool output rewrite the system prompt mid-session (cache-safeguards C8, flagged as a cache-breaking behaviour).
- AGENTS.md is deliberately not a protected path (`core/tools/permissions/protectedPaths.ts` ~197): an agent write to it is governed by `toolPermissions.ask`. Relevant to who may write memory.
- No model-writable memory store and no memory tool. `grep memory` in `core/tools`, `core/config` finds only unrelated hits.

**Persistence and footprint** (from `plans/memory-and-history.md`, hypotheses until V0)

- Core: `core/util/history.ts` `HistoryManager` writes the whole session as one JSON file (`getSessionFilePath` in `core/util/paths.ts:260`); `Session.checkpoints` added per `plans/checkpoints.md`.
- GUI: `gui/src/redux/slices/sessionSlice.ts` holds all history; `Chat.tsx` is unwindowed; `ToolTruncateHistoryIcon` lets the person truncate history at a tool call (the only manual ageing control, destructive).
- CLI: `session.ts` writes `<sessionId>.json`; `ChatHistoryService` holds everything; `ResourceMonitoringService` samples RSS/heap but nothing acts on it; `loop/loopSession.ts` keeps per-item transcripts.
- Cache: the ledger and `useWarmCacheNote` give a shared "cache is warm" sentence; cache plans in `plans/cache-*.md`, `plans/prompt-caching.md`.

**Gap summary.** (a) No policy for aged tool output in the request. (b) Truncation is silent and mid-prefix. (c) Two compaction prompts. (d) No model-writable memory. (e) Footprint unmeasured. (f) Nothing that shows the person what the model currently carries; `plans/context-visibility.md` is the natural home for that view and the memory panel should reuse it rather than build a second one.

## 3. Evidence (2026)

**Masking versus summarising.**

- Lindenbauer et al., JetBrains Research, "The Complexity Trap", arXiv:2508.21433 (v1 29 Aug 2025, v3 27 Oct 2025; NeurIPS 2025). Verified from the arXiv abstract: observation masking roughly **halves cost versus the raw agent while matching the solve rate** of LLM summarisation, on SWE-agent with SWE-bench Verified across five model configurations; a hybrid saves a further 7% over masking and 11% over summarisation. A search snippet reports Qwen3-Coder 480B at 54.8% (masking) versus 53.8% (summarisation); I did not verify that figure in the paper. The paper's own scope: SWE-bench, SWE-agent scaffold, initial OpenHands check. It did not measure prompt-cache effects (see below).
- arXiv:2606.10209 "Less Context, Better Agents" (June 2026): recency pruning of tool call/response pairs plus summaries of the evicted pairs, best at "last 5 tool calls + summary"; enterprise tool use, not coding. Seen via search result only.
- Atlassian Rovo Dev, 30 Mar 2026 (https://www.atlassian.com/blog/developer/rovo-dev-keeps-long-sessions-useful): staged "structured forgetting", bulky machine output first, then tool inputs, then assistant text, protect the task framing and the recent tail, summary collapse last. No numbers, no mention of caching. Useful as a **ordering** to copy, not as evidence.
- SWE-Pruner arXiv:2601.16746 (Jan 2026) prunes file-read output at line level with a goal hint; "Beyond Compaction" arXiv:2606.11213 and "Context as a Tool" (ACL Findings 2026) are eviction/folding variants. Search snippets only.
- No source found that measures **cache reads and dollar cost** across masking, summarising and no ageing. That is the gap our V0 harness fills, and it is the number this fork most needs.

**Vendor mechanisms.**

- Anthropic context editing (https://platform.claude.com/docs/en/build-with-claude/context-editing.md): `clear_tool_uses_20250919` with `trigger` (default 100,000 input tokens), `keep` (default 3 tool uses), `clear_at_least`, `exclude_tools`, `clear_tool_inputs` (default false); placeholder replaces cleared results; the client keeps full history. The page states that **clearing invalidates the cached prefix** and that `clear_at_least` exists so the saving exceeds the rebuild. Thinking-block clearing is separate and, if kept, preserves cache. The page now recommends server-side compaction (`compact_20260112`) as the primary strategy and says client-side SDK compaction is deprecated. The page's `applied_edits` response field reports how much was cleared, which is the model for our ledger entry. Beta, ZDR-eligible.
- Anthropic's announcement reports memory tool plus context editing +39% and context editing alone +29% on an internal agentic search eval (https://www.anthropic.com/news/context-management, via search snippet; vendor figure, not independently reproduced).
- Memory tool (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md): client-side, `memory_20250818`, a `/memories` directory, commands view/create/str_replace/insert/delete/rename, path-traversal validation is the application's job, caps and expiry recommended, auto-injected "view your memory first, assume interruption" protocol in the system prompt. Context editing warns the model to save before results are cleared. The doc recommends compaction plus memory together.
- Claude Code (https://code.claude.com/docs/en/memory): CLAUDE.md (person-written, target under 200 lines) and auto memory (Claude-written, `~/.claude/projects/<project>/memory/`, `MEMORY.md` index first 200 lines or 25KB loaded at start, topic files read on demand, shared across worktrees, plain markdown, `/memory` to browse, `autoMemoryEnabled` toggle, `autoMemoryDirectory`, exempt from transcript retention sweep, a reminder to the model when the index nears its limit). Design to copy: index plus on-demand topic files, hard size cap on what is always loaded, plain files.
- OpenHands (https://docs.openhands.dev/sdk/guides/context-condenser, https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents): condensers as a pluggable interface; `LLMSummarizingCondenser` (max_size, keep_first); an observation-masking condenser (attention window, default 5 per a community gist, unverified) that is a **view over an immutable event store**. Copy the shape: ageing is a view function over a lossless log, which is exactly what V4 plus V5 describe.
- Letta/MemGPT: editable in-context "memory blocks" plus out-of-context recall/archival; sleep-time agents rewrite blocks in the background (https://www.letta.com/blog/memory-blocks, via search). Needs a server and a second model; poor fit for small local models.
- Mem0 / Zep: vendor-reported LoCoMo figures disagree (Mem0 ~91 to 92.5, Zep ~80 to 83 on its own page, one blog 94.7) and the vendors dispute the method (via search summaries). **Do not use these numbers.** They solve cross-user personalisation with a service, which conflicts with local-first and no-telemetry.
- Cline: memory bank is a set of markdown files plus a rules block telling the model to read them; separate from Auto Compact (secondary sources only). Same family as AGENTS.md plus a progress file.
- Codex CLI: reported memory preview (April 2026) that summarises sessions in the background into `~/.codex/memories/`, config flags `memories` and `generate_memories` (one blog; check OpenAI's page). Cursor: sources conflict on whether Memories still exist (removed in 2.1 per one 2026 guide). Treat both as unverified.
- Aider: repo map with a token budget (`--map-tokens`, default 1k, graph-ranked, https://aider.chat/docs/repomap.html). Its docs page says nothing about history summarisation, so I cannot cite it for that. Relevant here only as a "budgeted, ranked, regenerated view" precedent that `generateRepoMap.ts` already follows.

**What the evidence does and does not give us.** Masking is cheap and as good as summarising on SWE-bench-like tasks with strong models. It was not tested on small local models, long sessions beyond SWE-bench trajectories, or with caching. All three are our conditions.

## 4. Constraints specific to this fork

- **Cache safety.** Any edit to a message already in the cached prefix invalidates the cache from that point to the end. So per-turn ageing (what OpenHands' masking does "on every step") is the wrong default here: it would rewrite the prefix every turn and turn cache reads into writes. Ageing must be **batched at a boundary** and priced.
- **Small and local models.** Context is often 8k to 32k; a summary call is an extra full-price request on a weak summariser that can drop file paths and facts. Masking costs no model call. Local servers (Strata, llama.cpp) have prefix caches too (K15 in ROADMAP), so "cache" is not only Anthropic/Bedrock.
- **Per-use prompts and models.** The fork has per-use model selection (`plans/model-config-ux.md`, CLI subagents as their own use). Compaction should be able to use a different model than chat, and its prompt should live in one place (today there are two).
- **Local-first, no telemetry.** All statistics are computed and shown locally; the V0 harness and any policy evaluation run on the person's own recorded sessions and are never uploaded. Recording a session for replay is opt-in and written to a local directory.
- **Permission model.** A model-written memory file is a write to a durable prompt-injection channel: content written in one session is loaded as trusted instruction in the next. It needs the same gate as AGENTS.md writes plus provenance.

## 5. Proposed ageing policy

Three layers, applied in this order; stop at the first that gets under the target.

| Layer          | What                                                                                                                              | Cost           | Cache effect                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| L0 Source caps | Truncate tool output when it is produced (head, tail, path to spilled file)                                                       | none           | none (never in prefix before it is final)                                                          |
| L1 Mask        | Replace the **body** of old tool results with a one-line stub: tool name, args hash, size, outcome, path to the spilled full body | none           | rewrites prefix from the oldest masked item forward, once per batch                                |
| L2 Summarise   | Existing compaction, with the summary prompt unified                                                                              | one model call | rewrites prefix from the summarised range; C25 makes the call itself cheap while the cache is warm |
| Drop           | Only on explicit person action ("Export and trim", truncate icon)                                                                 | none           | rewrite                                                                                            |

**What is masked.** Tool results (bash, read, grep, search, fetch) older than the last K tool uses, except: errors from the last N turns, results of tools in an `exclude` list (default: task list, anything the person pinned), results the model references in the last turn. Tool **inputs** stay (they are short and carry intent), matching Anthropic's `clear_tool_inputs=false` default and Rovo's ordering. Edits tools' results are masked but the diff stays recoverable through checkpoints (`plans/checkpoints.md`). **Never aged:** system prompt, first user message and constraints, last K turns, the task list, thinking blocks (clearing them invalidates cache on some providers per the docs above).

**When (trigger).** A fill ratio of the usable context (start proposal 0.6, tuned in V0) or an unavoidable boundary, whichever first:

1. Cache is cold or expired anyway (the rebuild is free: ageing then costs nothing extra). This is the preferred moment and should be taken opportunistically at every cold-cache request.
2. Cache is warm and the fill ratio crosses the trigger: age in **one batch** with a minimum reclaim (copy `clear_at_least`): only act if masking frees more tokens than a rebuild costs, estimated from the ledger's cache-read versus write prices. If it cannot, skip and let compaction run at the hard threshold.
3. Overflow: today's `compileChatMessages` splice. Replace the silent splice by L1-then-L2 so overflow takes the same, noticed path.

**Escalation to L2.** If L1 frees less than the target, or the remaining bulk is assistant text rather than tool output, run compaction. For models below a capability floor (to be set from the model-benchmark plan, `plans/model-benchmark.md`), prefer L1 and a "start a fresh session with notes" offer over a summary from the same weak model.

**Who decides.** Policy is a setting with three modes: `off`, `ask` (default for the IDE: show the note, one click), `auto` (default for headless/loop, where nobody can answer, with the note written to the log). The person can always run "Age now", "Undo last ageing" (possible because the lossless log is kept, V4), and pin an item so it is never masked. The model does not decide ageing, but may call a `recall(handle)` tool to pull a masked body back from the spilled file (this is the Anthropic "on-demand recall" pattern); a recalled body is appended as a new tool result at the tail so it does not edit the prefix.

**How cache cost is shown.** Reuse the cache-safeguards notice bar and `useWarmCacheNote`. Before an ageing batch while warm: "Free about 38k tokens of old tool output. The cache is warm, so the next request re-reads the prompt at full price (about 51k tokens written). Expected saving over the next 20 requests: about X. Age now / Later / Never this session." After: a ledger line next to C31's expected rebuild ("aged 41 tool results, freed 38k, rebuild 51k") so the session summary and Copy cache record include it. The miss detector must treat an ageing batch as an expected rebuild, like compaction, so it never reports a false cache miss.

## 6. Memory panel: content and edit model

One panel (IDE toolbar entry next to the cache tips; CLI `/memory` and a status segment), three tabs.

1. **Context now** (reuses `context-visibility.md`): what the next request contains by category with token counts (system, rules and AGENTS.md, memory index, task list, summary, live messages, masked stubs, tool results, images, reasoning), with a per-item "pin", "mask now", "recall". Shows cache state and the last ageing event.
2. **Notes** (durable memory): the files under a `memory/` directory (project: `.continue/memory/`, user: `~/.continue/memory/`; recommend project-scoped, shared across worktrees, as Claude Code does), listed as an index file plus topic files. The index is the only part always loaded, hard cap (start with 200 lines or 8 KB; Claude Code's 25 KB is a data point, not a requirement for small models); topic files load on demand through a read tool. The panel shows each entry with date written, session and model of origin, size, and last-read time.
3. **Footprint** (Track V's own statistics: process memory, history bytes by category, hot/warm/cold counts, DOM nodes, save cost, pressure) with "Free memory" and "Export and trim".

**Edit model.** Files are plain markdown, edited directly or from the panel; the person is the owner and can delete anything. A model-proposed write is a **proposal**: it shows as a diff in the panel and in the chat, and is applied on approval unless the person has set `memory.autoWrite` for that project. All writes go through one function (path confined to the memory root, size caps, secret scan, provenance front matter), never through the general file tools. Entries expire visibly (a "not read in 90 days" flag, never silent deletion; Anthropic recommends expiry but the choice of 90 days is ours and arbitrary). Changes to the memory index mid-session do not enter the cached prefix: the index is read at session start; a mid-session write updates the file and takes effect next session, or is appended as a tail message if the person asks for it now. This rule keeps the memory feature from becoming another C8.

Off by default. When on, the system prompt gains a short fixed paragraph (cacheable, constant) rather than a per-turn instruction.

## 7. Measurement harness (V0, extended)

V0 as planned measures footprint on synthetic sessions. Add **V0b: replay**.

- **Inputs.** Recorded real sessions (the CLI session JSON and the GUI export already exist; add an opt-in "save replay bundle" that stores request bodies and recorded tool results to a local directory, nothing uploaded). Plus a synthetic generator with controlled distributions (mostly small results, a few 50k outputs) and `bench/tier0/fixtures/loop-history.json` as a starting fixture.
- **Policies under test.** none, source-caps only, L1 at fill 0.4/0.6/0.8, keep K = 3/5/10, L2 only (current), L1 then L2, per-turn masking (negative control for cache cost).
- **Offline metrics (no model needed).** Tokens per request over the session, peak context, number of prefix rewrites, **simulated cache reads and writes** using the ledger's pricing model (`plans/prompt-caching-sim.mjs` already exists for this), total simulated cost, bytes in memory and on disk, save time, DOM nodes.
- **Online metrics (model in the loop).** Task success on a small replay-able task set: fork the recorded session at a point, apply the policy, let the model finish the recorded next step, score it by an automatic check (does the same tool call or edit result, tests pass). Run for at least three models: one hosted Claude, one mid local model, one small local (e.g. Qwen3-Coder 30B and Nova 2 Lite are already in `plans/turn-prompt-eval.md`, so the model harness and runs exist). Repeat each condition 5 times; the turn-prompt eval used five runs, same here.
- **Output.** A table per policy: cost, cache-read share, success rate, rebuild count, and the "break-even" fill ratio where ageing stops paying. Decision rule: adopt L1 default-on only if success is within a pre-stated margin of none (say 3 points, to be fixed before the run) and simulated cost is lower for at least two model classes.
- **Honesty.** The simulated cache cost depends on assumed prices and TTLs; validate the simulation against the real ledger on one live session per provider (the C25 live Bedrock figures are the model).

## 8. Build rows (sliceable)

Existing V0 to V8 keep their meaning. New rows use the prefix VA (request-side ageing) and VM (memory). Effort is rough: S under a day, M a few days, L a week or more.

| Row                | Slice                                                                                                                                                                                | Depends on                                      | Done when                                                                                | Size |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| V0                 | Footprint harness (as planned)                                                                                                                                                       | none                                            | table at 1k/5k/20k items                                                                 | M    |
| V0b                | Replay harness: opt-in replay bundle, offline policy simulator on `prompt-caching-sim.mjs`, report                                                                                   | V0 for shared fixtures only                     | the offline table in section 7 for the existing fixture and two real sessions            | M    |
| VA1                | Unify the two summary prompts and the two compaction code paths behind one policy function with the **ageing event** recorded in the cache ledger (also fixes the miss detector)     | C31                                             | one test shows an ageing event is not reported as a cache miss                           | S    |
| VA2                | Source caps on the IDE terminal path and spill files (this is V2's cap item; share the work)                                                                                         | V0                                              | no unbounded tool output reaches the history                                             | S    |
| VA3                | L1 masking as a pure view function over the history, behind `history.ageing: off` default, with stubs and a `recall` tool                                                            | VA1, V0b numbers                                | harness shows lower cost, success within margin                                          | M    |
| VA4                | Replace the silent splice in `compileChatMessages` with L1 then L2; note before and after                                                                                            | VA3                                             | no silent mid-prefix removal remains                                                     | M    |
| VA5                | Warm-cache note with the batch estimate (`clear_at_least` rule), "Age now / Later / Never", opportunistic ageing on cold-cache requests                                              | VA3, `useWarmCacheNote`                         | note shows estimates; a test fails if ageing happens warm without the note in `ask` mode | M    |
| VA6                | Per-use model for compaction and the small-model floor                                                                                                                               | VA1, model-config rows                          | compaction can use a different model; floor skips L2                                     | S    |
| V1                 | Statistics and panel shell (Footprint tab)                                                                                                                                           | V0                                              | as planned                                                                               | M    |
| VM1                | Context-now tab on `context-visibility.md` data, pin/mask/recall                                                                                                                     | VA3, V1                                         | the person sees and edits what the next request carries                                  | M    |
| VM2                | Notes: memory root, index plus topic files, single write function, proposal diff, caps, secret scan, provenance; off by default                                                      | permission model rows (`plans/policy-areas.md`) | a path-traversal and injection corpus test passes                                        | L    |
| VM3                | Memory tool or read/propose tools exposed to the model, fixed system paragraph, index read at session start only                                                                     | VM2                                             | a session writes a note, the next session loads the index, prefix unchanged mid-session  | M    |
| V4, V5, V6, V7, V8 | As planned. V5's rule D3 ("never age inside the window") is **superseded** for L1 only: stubs inside the window are allowed once VA3 exists, because the lossless body stays on disk | V4                                              |                                                                                          |      |

Suggested order: V0, V0b, VA1, VA2, then decide with numbers before VA3 to VA5. VM rows can run in parallel with VA after V1.

## 9. Risks

- **Masking hurts a weaker model** that needs the old output (the paper tested strong models). Mitigation: the harness decides; `recall`; pin; error results kept.
- **Cache thrash** if the trigger is set low or a trigger fires repeatedly. Mitigation: minimum reclaim, one batch, cooldown of N requests, a hard rule that ageing is skipped when it cannot pay for itself.
- **Prompt-injection persistence** through model-written memory. Mitigation: proposal-and-approve default, provenance, never auto-trust tool-result text as memory, one write path.
- **Provider differences:** server-side context editing exists on Anthropic/Bedrock but not for local servers; do client-side ageing as the one implementation and optionally map to server edits later (ledger must then read `applied_edits`).
- **Two prompts drift** until VA1 lands.
- **Panel scope creep:** three tabs in one panel is a lot; ship Footprint, then Context now, then Notes.
- **Memory staleness:** stale notes mislead the model more than none; the cap and the expiry flag are the controls, and notes carry dates.
- **Session format migration** (V4) while ageing relies on the lossless log: keep VA3 working on the old format (the view function does not care where bodies live).

## 10. Unverified list

- Whether the CLI and core compaction ever disagree in practice, and which prompt works better with small models (not measured).
- That `compileChatMessages` removes middle messages in the way described (I read the splice at line ~550 but not the whole selection logic).
- The IDE terminal path's retention (the plan itself says unchecked).
- Qwen3-Coder 480B 54.8% vs 53.8% (search snippet only); the paper's window sizes and its OpenHands result; the numbers 7% and 11% are from the abstract and verified.
- arXiv 2606.10209, 2606.11213, 2601.16746, 2608.00808 and the ACL 2026 CAT paper: titles and one-line findings from search snippets, papers not opened.
- OpenHands masking default window of 5 (a community gist; the SDK docs I did not read in full).
- Letta sleep-time details, Cline memory bank and Auto Compact behaviour, Codex memories (April 2026), Cursor Memories removal in 2.1: secondary sources only.
- Mem0, Zep, Letta benchmark figures: vendor-reported and disputed; not used for any decision.
- Anthropic +29% / +39% figures: from the announcement via a snippet, internal eval, not reproduced.
- Anthropic "compact_20260112" server-side compaction semantics and its interaction with caching: named on the context-editing page, the compaction page was not read. Check before deciding VA6 and before treating "client-side compaction" as a Claude-only legacy.
- The last 7,803 characters of the context-editing page (tool-use edge cases) were not read.
- Aider history summarisation: not covered by the docs page I read.
- All default numbers in sections 5 and 6 (fill 0.6, K = 3/5, 200 lines/8 KB, 90 days, 3-point margin) are proposals, not findings.
- Break-even economics depend on each provider's cache read/write price ratio and TTL; take them from the ledger, not from this document.
