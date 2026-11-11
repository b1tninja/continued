# Prompt segments (K18 slice 1) and the cache-order tests (C62)

Status: slice 1 landed with this document. Nothing a request carries has changed: the manifests describe it, and byte-identity goldens (below) prove it.

## What a segment is

A chat request is read by the provider as tools, then system, then messages, and a prompt cache reads a prefix of that. So what changes least must come first. `core/llm/promptSegments.ts` (plain TypeScript, safe for the GUI webview) types that:

| Field       | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `id`        | stable name: `turn.act@full`, `rules.session:<name>`, `env.date+git`, `tools.builtin@agent` |
| `region`    | `tools`, `system`, `first-user`, `history`, `tail`, in request order                        |
| `stability` | `static` (same for a model and mode), `session`, `turn`, `request`                          |
| `tokens`    | characters / 4, the repo's conservative proxy                                               |
| `hash`      | first 12 hex of sha256 of the text (`core/util/secretScan/sha256.ts`)                       |
| `exposedTo` | the volatile-early offenders the segment's inputs expose the prefix to                      |

A segment holds no text. The validator (`validateManifest`) rejects: regions out of order, a less stable segment before a more stable one in the same region, a per-request segment outside the tail, duplicate ids, and a `format` segment (a rendered call format) in a request that also sends native tools (Q29).

Two adapters build manifests from the same inputs the request builders use, without changing the request:

- IDE: `gui/src/redux/util/describeChatRequest.ts` calls the real `buildChatRequest`, `getBaseSystemMessage` and `generateToolsSystemMessage` and splits the final system message at the places those produced.
- CLI: `extensions/cli/src/promptSegments.ts` splits the system message `constructSystemMessage` writes at the markers it writes (`SYSTEM_MARKERS`, now one constant shared by the builder and the adapter), and describes the tool list, environment block, history, tail and task list block of `buildChatRequestBody`.

## The runtime dump

`CONTINUE_PROMPT_SEGMENTS=1` prints one line per segment of every request, never contents:

```
[prompt-segments] req=2 model=claude-sonnet-4-6 compaction=false
  tools.builtin@agent region=tools stability=static tokens=1846 hash8=4322f192
  turn.act@full region=system stability=static tokens=586 hash8=dc81e6a6
  rules.user region=system stability=session tokens=29 hash8=eebc5b84
  env.date+git region=first-user stability=session tokens=46 hash8=bcc74e66
  history region=history stability=turn tokens=103 hash8=11a30153
  total_tokens=2900 first_changed_vs_prev=none
```

- CLI: set the environment variable; lines go to stderr. The variable is read once at load; with it unset the call returns on its first line and builds nothing.
- IDE: the webview has no environment, so set the local storage key of the same name to `1` in the webview's developer tools; lines go to the console (`console.info`). With the key unset the cost is one storage read per request.

Reading it: `first_changed_vs_prev` names the first segment in tools, system or the first user message whose hash differs from the previous request's, or `none`, or `first` for the first request. History and the tail are not compared: they grow by design. A request that is not `none` is a prefix break, and the id says what to blame. Compare the `hash8` of a static segment across runs to see a prompt text change.

## Measured segments (chars / 4, test scenarios)

IDE (`gui/src/redux/util/segmentScenarios.ts`, six tools):

| Segment                                   | agent      | plan       | agent + task list | qwen3-coder prompted    |
| ----------------------------------------- | ---------- | ---------- | ----------------- | ----------------------- |
| `tools.builtin@<mode>`                    | 2,640      | 1,534      | 3,325             | none (native tools off) |
| `turn.<mode>@<profile>`                   | 687 (full) | 806 (full) | 687               | 545 (tailored)          |
| `format.agent` (prompted tools block)     |            |            |                   | 902                     |
| `rules.session:always`                    | 9          | 9          | 9                 | 9                       |
| `summary.compaction` (compacted scenario) | 15         |            |                   |                         |
| `task-list`                               |            |            | 95                |                         |
| `tail.turn`                               |            |            |                   | 18                      |

CLI (`extensions/cli/src/stream/segmentScenarios.ts`, real tool definitions):

| Segment                            | agent (+ task list, 3 MCP) | plan  | agent plain | subagent |
| ---------------------------------- | -------------------------- | ----- | ----------- | -------- |
| `tools.builtin@<mode>`             | 1,846                      | 2,503 | 1,359       | 1,359    |
| `tools.mcp`                        | 108                        |       |             |          |
| `preamble`                         | 113                        | 113   | 113         | 113      |
| `turn.act@full` / `turn.plan@full` | 586                        | 704   | 586         | 586      |
| `commit-signature`                 | 58                         |       | 58          | 58       |
| `rules.user`                       | 29                         | 29    | 29          | 29       |
| `subagent.prompt`                  |                            |       |             | 11       |
| `env.date+git`                     | 46                         | 46    | 46          | 46       |
| `task-list`                        | 11                         |       |             |          |

The scenario tool sets are fixed fixtures, so the totals are not the shipped tool overhead (`plans/tool-overhead.md` has those). Budgets in `core/llm/promptSegmentBudgets.json` are today's size plus 15 percent.

## Volatile-early offenders the manifests make visible

From `plans/prompt-segment-plan.md` section 6. Each is asserted by a BASELINE test that records today's behaviour; the PR that fixes one flips its expectation.

| Offender                                                   | Visible as                                                                                                   | Test          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| Plan-to-act switch (tools and system both change)          | `mode-switch` on `tools.builtin@*` and `turn.*`; first change is the tools segment                           | IDE and CLI   |
| First-time file-scoped rule appended to the system message | `rules.scoped:<name>` is a `turn` segment in the system region; first change names it                        | IDE           |
| `task_list` or loop tools appearing                        | `tool-list-event` on `tools.builtin@*`; first change is the tools segment                                    | IDE and CLI   |
| MCP tool order                                             | CLI `tools.mcp` carries `mcp-order`; a reordered list changes it first (the IDE sorts, so no exposure)       | CLI           |
| Registry text in Subagent and Skills descriptions          | `registry-in-tool-description` when those tools are in the list (not hit by the fixtures, which omit them)   | not exercised |
| AGENTS.md edit                                             | `instruction-file-edit` on `rules.user`; editing the file changes it first                                   | CLI           |
| Uncapped git status                                        | `uncapped-git-status` on `env.date+git` (the code has no cap; a new date or status changes it, as on resume) | CLI           |
| Compaction summary in the IDE system message               | `summary.compaction` is a `turn` segment in the system region                                                | IDE           |

One more the manifest found that the plan did not list: a subagent's own prompt is appended after the user rules, a static segment after a session one (`subagent.prompt` follows `rules.user`), which the validator reports as a rank inversion in the CLI subagent scenario. It is recorded as a known inversion in the test.

## The tests

- Byte-identity goldens (`gui/src/redux/util/requestGolden.json`, `extensions/cli/src/stream/requestGolden.json`): the hash of the serialized messages and tools each scenario builds. Recorded on origin/main before any builder was touched (the CLI ones were re-recorded once, still on unmodified builders, when the first recording turned out to use the suite's mocked `constructSystemMessage`). Update deliberately with `WRITE_GOLDEN=1`.
- Manifest tests (`describeChatRequest.test.ts`, `promptSegments.test.ts`, `core/llm/promptSegments.vitest.ts`): canonical order, token budgets, static-hash goldens (`segmentGolden.json`, `promptSegmentGolden.json`), prefix stability for a changed task list, a new message, a tail, a different day, a compaction request, and negative controls (a volatile segment first, a format segment beside native tools, a timestamp in a static segment, a shuffled tool list).
- Scenarios covered: IDE agent, plan, prompted tools (Qwen3-Coder), Nova (same request as agent; no tool cache point is an adapter matter), loop item, compaction, scoped rule; CLI agent, plan, subagent, compaction, resume. Not covered: provider placement of cache points (the next slice, with `prefixStability.test.ts`).

## Prior art (read 2026-11-10)

- Anthropic prompt caching, https://platform.claude.com/docs/en/build-with-claude/prompt-caching (in `plans/prompt-segment-plan.md` section 13): order tools, system, messages; changing tools invalidates everything.
- Claude Code, https://code.claude.com/docs/en/prompt-caching: mode, skills and file edits are appended as messages; instructions read once per session.
- OpenAI, https://developers.openai.com/api/docs/guides/prompt-caching: stable content first, timestamps last.
- Aider, https://aider.chat/docs/usage/caching.html: caches, in this order, the system prompt, read-only files, the repository map, then editable files; Anthropic and DeepSeek only; `--cache-keepalive-pings` pings every 5 minutes to keep the cache warm. Aider has no per-request volatile section to speak of: the order is the whole design.
- Cline, https://docs.cline.bot/model-config/context-windows: nothing on caching or ordering on that page. Cursor: not read.
