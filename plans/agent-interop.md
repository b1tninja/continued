# Agent interop: sessions that message and start each other

Last updated: 2026-11-07. Status: research and design; nothing built. Target: 2.6 or later, after parallel agents ([`parallel-agents.md`](./parallel-agents.md)) phases A2 and A3. Not part of 2.4.

Let an agent session talk to another one as a tool call: send it a message, start one in a given mode, wait for its result, ask its parent a question. And look at whether the modes themselves (chat, plan, agent, loop) are better offered to a parent as one tool with a `mode` than as separate machinery.

## What others do

Sources were checked on 2026-11-07. Anything marked unverified came from a secondary source only.

- **Claude Code** has three layers:
  - **Subagents** run through the `Agent` tool. Their frontmatter has `model`, `tools`/`disallowedTools`, `permissionMode` (including `plan`), `maxTurns`, `background`, `isolation: worktree` and `effort`. A named one can be resumed with `SendMessage`. A background subagent's result arrives on a later turn, and its permission prompts surface in the parent. ([docs](https://code.claude.com/docs/en/sub-agents))
  - **Cross-session messaging** uses `ListAgents` and `SendMessage` ([docs](https://code.claude.com/docs/en/cross-session-messaging)):
    - A message is plain text, read between tool calls, or it starts a turn when the receiving session is idle.
    - It never counts as the user's consent and cannot change config.
    - The receiver can accept, hold or refuse inbound messages.
    - Bursts are rate-limited and identical repeats dropped, so a ping-pong loop stops on its own.
  - **Agent teams** (experimental) are a lead plus teammates with a shared task list and per-agent inboxes. ([docs](https://code.claude.com/docs/en/agent-teams))
- **Cursor** has subagents with `model`, `readonly` and `is_background`, one level deep, resumable by ID. `/multitask` turns queued requests into background subagents. Its Cloud Agents API (beta) has launch, list, follow-up with steering, cancel and a stream. ([subagents](https://cursor.com/docs/subagents), [API](https://cursor.com/docs/background-agent/api/overview))
- **OpenAI**:
  - In the Agents SDK, a handoff is a tool, `transfer_to_<agent>`, that moves the conversation to another agent. `Agent.as_tool()` instead runs an agent and returns its result. ([docs](https://openai.github.io/openai-agents-python/handoffs/))
  - Codex multi-agent is experimental. ([docs](https://developers.openai.com/codex/multi-agent))
  - Codex's tool names (`spawn_agent`, `send_input`, `wait`, `close_agent`) are unverified.
  - Its MCP server mode was removed in favour of an experimental JSON-RPC "app server".
- **A2A 1.0** ([spec](https://a2a-protocol.org/latest/specification/)):
  - Objects: agent cards, tasks, messages and artifacts.
  - Task states include `INPUT_REQUIRED`.
  - Methods: SendMessage, GetTask, ListTasks, CancelTask, SubscribeToTask.
  - A `contextId` groups the tasks of one conversation.
- **MCP Tasks** (spec 2025-11-25, experimental) let a `tools/call` return a task ID at once, followed by `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel`. Their states are working, input_required, completed, failed and cancelled. With this, a session could be offered to any MCP client as a tool. ([spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks))
- **VS Code's Agent Host Protocol** syncs clients with a host-owned session through snapshots and an action stream. It does not define messaging between sessions. ([blog](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture), [protocol](https://microsoft.github.io/agent-host-protocol/))

## What this fork has

| Piece                                                                                                 | Where                                                                | Gap                                                                                        |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The `subagent` tool, `{agent, description, prompt}`; up to 3 at once; synchronous; no nesting         | `core/tools/definitions/subagent.ts`, `core/subagents/scheduling.ts` | No mode, no background, no result handle                                                   |
| Agent definitions from `.claude/agents`                                                               | `core/subagents/definitions.ts`                                      | No `mode`/`permissionMode`, `readonly`, `background` or `isolation` (A4 adds the last two) |
| `cn serve`: `GET /state`, `POST /message {message, steer}`, `/pause`, `/permission`, `/diff`, `/exit` | `extensions/cli/src/commands/serve.ts`                               | Already send, steer, status and stop for one session; nothing lists or starts sessions     |
| Modes `chat`, `agent`, `plan`, `background`                                                           | `MessageModes` in `core/index.d.ts`                                  | Loop mode lives on its own branch, as a controller over Agent and Plan                     |

## Tools between sessions

| Tool                      | Arguments, result                                                                               | Built on                   | Safeguards                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`           | → `[{id, title, mode, folder, branch, status}]`                                                 | the A1 panel's model       | Only this window's agents                                                                                                                                                                 |
| `send_message`            | `{to, text, steer?}`                                                                            | `POST /message`            | Arrives marked as from another agent; never approves a tool call or changes settings; rate limit, repeats dropped, length cap; the receiver's setting can hold or refuse inbound messages |
| `start_session`           | `{prompt, agent?, model?, mode, folder?, worktree?, budget?: {tokens, turns, wallMs}}` → `{id}` | A2 (`cn serve`), A3        | A writing mode gets its own worktree or is refused; a started session cannot start others (depth 1); the per-run budget applies                                                           |
| `wait_for` / `get_result` | `{ids, timeoutMs?}` → `{status, report, diffSummary}`                                           | `GET /state`, `/diff`      | Always has a timeout; states as MCP Tasks and A2A: working, input_required, completed, failed, cancelled                                                                                  |
| `ask_parent`              | `{question, default?}`                                                                          | loop mode's held questions | Returns the default if given, else waits as input_required; approvals still go to the person, never to the parent                                                                         |
| `share_artifact`          | `{path or text, to}`                                                                            | the worktree service (A3)  | A read-only copy; a session never writes into another's checkout                                                                                                                          |
| `cancel`                  | `{id}`                                                                                          | `/pause`, `/exit`          | The same as Stop on a row                                                                                                                                                                 |

## Modes as tool calls

Offering each mode to a parent as a tool looks attractive:

- `plan(task)` returns a plan file.
- `agent(task, worktree)` runs headless.
- `loop(goal, stop)` runs with loop mode's stop conditions.

Each returns a typed result: a plan file, a diff or a report.

Four more tools in every parent's prompt cost tokens and cache, though. `chat` as a tool is a subagent without tools. And `loop` inside an agent is nested autonomy that multiplies spend.

Recommendation: one `mode` argument instead, on `start_session` and the subagent tool, and a `mode` field in agent definitions:

| Mode    | What it gets                                   |
| ------- | ---------------------------------------------- |
| `chat`  | No tools                                       |
| `plan`  | Read-only tools plus the plan-file tool (F4)   |
| `agent` | The full tool set                              |
| `loop`  | Only for top-level or `cn serve` (A2) sessions |

A `.claude/agents` file can then fix an agent's mode, as Claude Code's `permissionMode` and Cursor's `readonly` do.

## Phases

| Phase | Scope                                                                                                                            | Depends on          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| M1    | `mode` (and `readonly`) in agent definitions and on the subagent tool; a `plan` subagent returns a plan file                     | S2, F4              |
| M2    | `list_sessions`, `send_message` and `cancel` over `cn serve`, with the marking, rate limits, no approvals and an inbound setting | A2                  |
| M3    | `start_session`, `wait_for` and `get_result`, with Task-shaped states, per-run budgets and depth 1                               | A2, A3, M1          |
| M4    | `ask_parent`: an input_required state routed to the parent or the person                                                         | M3, loop mode       |
| M5    | `loop` as a mode for `cn serve` sessions                                                                                         | M3, loop mode       |
| M6    | `share_artifact` between worktrees                                                                                               | A3, M3              |
| M7    | Later: a `cn serve` session as an MCP server with Tasks, or an A2A agent card                                                    | M3; specs to settle |

## Risks

- **Runaway cost.** Two agents messaging each other, or loops inside loops, can spend without limit. Rate limits, dropped repeats, depth 1 and hard budgets are part of M2 and M3, not later additions.
- **Laundered authority.** A message from another agent must never count as the person's approval, or work around a refusal. Claude Code's rules are the model to follow.
- **Two writers in one checkout.** The worktree service (A3) has to enforce this, not just advise against it.
- **Moving specifications.** MCP Tasks, Codex multi-agent and agent teams are experimental, and Codex removed its MCP server. Keep the internal API independent of any one protocol, and add M7 only once a spec settles.
- **Loop mode is not on this branch yet.** M4 and M5 wait for it.
