# Research: hooks, upstream backlog, planning and code intelligence

Draft, started 2026-11-11. Status: part 2 (hooks) and part 3 (backlog) collected; parts 4 (planning) and 5 (code intelligence) still to write. Docs only; nothing here was run. Repository state read at `origin/main` 0d4fe36f3. Every URL below was fetched on 2026-11-11.

## 1. What is built here (read from the tree)

- Hooks: `extensions/cli/src/hooks` (types, loader for six settings files, runner, trust, prompt hook, `fireHook.ts` with eleven helpers). Call sites found by grep: `PreToolUse`, `PostToolUse`, `PostToolUseFailure` (`stream/toolHooks.ts`), `UserPromptSubmit` (`commands/chat.ts`, `serve.helpers.ts`, `serve.messages.ts`), `SubagentStart` and `SubagentStop` (`subagent/executor.ts`). Not called from outside the hooks directory: `Stop`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompact`; the `PermissionRequest` path was not found either. ROADMAP row D4 says not started, which matches. No hooks in the IDE (D5).
- Planning: Track F. `plans/task-planning.md` records P1, P3, the CLI strip from P2 and P4 as built, while the ROADMAP table for Track F has no state column and lists F0 to F6 as scope. The two should be reconciled.
- Index: Track L, all rows "Not started". The bundled embeddings model is the 8-bit quantised all-MiniLM-L6-v2 (384 dimensions) through transformers.js (`core/llm/llms/TransformersJsEmbeddingsProvider.ts`, `extensions/vscode/models/`).

## 2. Hooks: the field

Sources: Claude Code hooks reference <https://code.claude.com/docs/en/hooks> (first 100,000 of 293,021 characters read), Agent SDK hooks <https://code.claude.com/docs/en/agent-sdk/hooks>, Codex hooks <https://developers.openai.com/codex/hooks> (redirects to <https://learn.chatgpt.com/docs/hooks>), Gemini CLI <https://geminicli.com/docs/hooks/reference/> (the page says Gemini CLI was replaced by Antigravity CLI on 2026-06-18), Cline <https://docs.cline.bot/sdk/plugins.md> (the old hooks page is now a stub pointing here).

### 2.1 Events

| Event               | Claude Code                                                                                                                                                                 | Codex                    | Gemini CLI                                   | Cline SDK plugin        | Here                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| PreToolUse          | yes, blocks                                                                                                                                                                 | yes, blocks              | BeforeTool                                   | beforeTool              | wired                                                           |
| PostToolUse         | yes                                                                                                                                                                         | yes                      | AfterTool                                    | afterTool               | wired                                                           |
| PostToolUseFailure  | yes                                                                                                                                                                         | no                       | no                                           | no                      | wired                                                           |
| PermissionRequest   | yes                                                                                                                                                                         | yes                      | no                                           | policy in beforeTool    | type only; no call site found                                   |
| UserPromptSubmit    | yes, blocks                                                                                                                                                                 | yes, blocks              | BeforeAgent                                  | beforeRun               | wired                                                           |
| Stop                | yes, can continue the turn                                                                                                                                                  | yes                      | AfterAgent                                   | afterRun                | type only (D4)                                                  |
| SessionStart, End   | yes                                                                                                                                                                         | yes                      | yes                                          | no                      | type only                                                       |
| SubagentStart, Stop | yes                                                                                                                                                                         | yes                      | no                                           | no                      | wired                                                           |
| PreCompact          | yes, blocks                                                                                                                                                                 | yes, plus PostCompact    | PreCompress, advisory                        | no                      | type only                                                       |
| Notification        | yes                                                                                                                                                                         | no                       | yes                                          | no                      | type only                                                       |
| Model request       | PreModelSwitch, Post                                                                                                                                                        | Pre and PostModelRequest | BeforeModel, AfterModel, BeforeToolSelection | beforeModel, afterModel | none                                                            |
| Others              | 14 more (PostToolBatch, TaskCreated, TaskCompleted, InstructionsLoaded, FileChanged, CwdChanged, Elicitation, StopFailure, MessageDisplay, UserPromptExpansion, Setup, ...) | Interrupt                | none                                         | onEvent                 | ConfigChange, TaskCompleted, TeammateIdle, Worktree* typed only |

The Claude Code page read lists 31 events. We type 17 and wire seven.

### 2.2 Input, output and failure semantics

| Point           | Claude Code                                                                                                                   | Codex                                                  | Gemini CLI                                                     | Here                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Config          | `settings.json` `hooks`: event, matcher group, handlers                                                                       | `hooks.json` or `config.toml`, same shape              | `settings.json`, `matcher`, `sequential`                       | Claude Code shape, six files                                                                                                 |
| Matcher         | exact or `a\|b` list when only `[A-Za-z0-9_ ,-\|]`, otherwise unanchored JS regex; field per event                            | field per event                                        | regex on tool name                                             | one regex; empty or `*` matches all. Check `hookRunner.ts` for whether `Edit` also matches `NotebookEdit`; there it does not |
| Extra filter    | `if` in permission-rule syntax, best effort                                                                                   | none                                                   | none                                                           | none                                                                                                                         |
| Common input    | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `prompt_id`, `effort`, `agent_id`, `agent_type` | adds `model`, `turn_id`                                | adds `timestamp`                                               | `session_id`, `transcript_path`, `cwd`, `permission_mode`                                                                    |
| Exit 0          | JSON on stdout, or plain text as context on some events                                                                       | same                                                   | JSON only; stdout must otherwise be silent                     | as Claude Code                                                                                                               |
| Exit 2          | blocking error, stderr to the model; JSON cannot override                                                                     | same                                                   | same                                                           | same                                                                                                                         |
| Other exit      | non-blocking, one-line notice                                                                                                 | hook marked failed                                     | non-fatal warning                                              | **blocks** on events that can stop something (D1)                                                                            |
| Failure option  | `onFailure: "block"` on command and http hooks (v2.1.295 and later)                                                           | none documented                                        | none                                                           | `onError: "block" or "allow"`, default block                                                                                 |
| Timeout default | 600 s (30 s for UserPromptSubmit); a PreToolUse timeout does not block unless `onFailure`                                     | 600 s                                                  | 60 s                                                           | 30 s on blocking events, 600 s others; blocks                                                                                |
| Decision output | `hookSpecificOutput.permissionDecision` allow, deny, ask, defer; `updatedInput`; top-level `decision: "block"` elsewhere      | allow, deny (no ask); `updatedInput`                   | `decision` allow, deny, block; `hookSpecificOutput.tool_input` | `permissionDecision`, `updatedInput`, `additionalContext`; deny beats ask beats allow                                        |
| Async           | `async: true` (not timed, cannot decide), `asyncRewake`                                                                       | `async`                                                | no                                                             | `async` on command hooks                                                                                                     |
| Handler types   | command (with `args` exec form), http, mcp_tool, prompt, agent                                                                | command, mcp_tool; prompt and agent parsed and skipped | command only                                                   | command, http, prompt (`promptHook.ts`), agent (fails closed)                                                                |

The Agent SDK uses the same JSON and the same `deny` over `defer` over `ask` over `allow` precedence, adds `onFailure: "block"` per matcher, and notes that a callback timeout on PreToolUse blocks the call (<https://code.claude.com/docs/en/agent-sdk/hooks>, section "Hook timeout"). The reference page and the SDK page do not agree on whether a PreToolUse timeout blocks for command hooks; we decided to block, which is the safe side of that disagreement.

### 2.3 Trust and security model

| Tool          | Project hooks                                                                                                                                                                                            | Managed only                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Claude Code   | follow workspace trust; docs say review `.claude/settings.json` changes like code; `allowedHttpHookUrls`, `httpHookAllowedEnvVars`; `if` is best effort                                                  | `allowManagedHooksOnly`, `disableAllHooks` |
| Codex         | non-managed hooks must be reviewed and are trusted by hash of the exact definition; a changed bundled script needs re-review; `/hooks` UI; `--dangerously-bypass-hook-trust`                             | `allow_managed_hooks_only`                 |
| Gemini CLI    | not on the page read                                                                                                                                                                                     | not on the page read                       |
| Cline plugins | worker thread per plugin, "crash isolation, not a security boundary"; 3 s hook timeout; five failures disable a plugin                                                                                   | none                                       |
| Here          | trust by project path plus fingerprint of the definitions and, in PR #541 (open), the sha256 of a workspace script the command runs; a project hook's `allow` is ignored; no environment variable bypass | none (open decision in `hooks-wiring.md`)  |

Findings:

1. We are ahead of Claude Code on the two points that matter when a repository ships hooks: fail closed by default, and a project hook cannot approve. Codex is closest on hashing and re-review. Both Codex and Claude Code say hooks are a guardrail and not a boundary (some tool paths bypass them); our D4 docs page should say the same.
2. **Compatibility gap that costs users**: the option meaning "a failure blocks" is `onFailure: "block"` in Claude Code and `onError` here, with opposite defaults. A file shared between the tools is read two ways.
3. Exit 2 plus stderr is portable across all four tools; JSON `hookSpecificOutput` is portable between Claude Code, Codex and the Agent SDK.

### 2.4 Proposed dialect

Target: the Claude Code settings shape and JSON, because Codex and the Agent SDK converge on it.

- Accept every Claude Code event name; log and ignore the ones we never fire.
- Add input fields scripts read: `prompt_id`, `agent_id`, `agent_type`, plus `model` (Codex) and `timestamp` (Gemini), which cost nothing.
- Accept `onFailure` as a synonym for `onError` (`continue` means `allow`).
- Add the `args` exec form for command hooks (no shell; removes the quoting and `cmd.exe` problems that `hooks-wiring.md` lists for Windows).
- Add `if` using our permission-rule syntax, documented as best effort.
- Wire `Stop` (with the `stop_hook_active` guard), `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`, `PermissionRequest`.
- Environment: `CLAUDE_PROJECT_DIR` alongside a native `CONTINUOUS_PROJECT_DIR`, on the scrubbed environment already used for agent commands.

## 3. Upstream backlog

Method: GitHub search API, `repo:continuedev/continue is:issue is:open`, sorted by reactions, <https://api.github.com/search/issues?q=repo:continuedev/continue+is:issue+is:open&sort=reactions&order=desc&per_page=100>, fetched 2026-11-11. There are 285 open issues in all. The REST issues endpoint has no reaction sort, so the search endpoint was used. Reaction counts are small except for requests for other editors.

Top of the list: #917 Neovim (245 reactions), #759 Visual Studio (115), #1729 plain-text keys (32), #1440 Sublime (24), #12912 narrow chat pane (23), #4791 `npx` MCP on Windows (17), #702 Eclipse (14), #7636 code-server terminal output (13), #10512 terminal "automatic" still asks (13).

Checked so far against this tree:

| Issue                           | Finding                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1729, #4643 keys in plain text | `core/config/secretStorage.ts`, `modelCredentials.ts` and a secure-storage test exist; the default is not yet verified                                  |
| #917, #759, #1440, #702, #2883  | `extensions/cli/src/acp/` and `docs/guides/acp.mdx` exist, so Neovim and Zed users have an ACP route; Visual Studio, Sublime, Eclipse stay out of scope |
| #4791 `npx` on Windows          | not confirmed; `MCPConnection.ts` has an `npx` list and an install hint near line 532                                                                   |
| #13185 JetBrains 2026.2         | `ContinueBrowserService.kt` still references `JBCefApp`; not confirmed                                                                                  |

The full top-60 triage table is the next revision.

## 4. Planning and 5. Code intelligence

To be written. Prior art is already in `plans/task-planning.md` and `plans/codebase-index.md`.
