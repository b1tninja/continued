# Parallel agents: an Agents panel, worktrees, Build in parallel

Last updated: 2026-11-07. Status: research and design; nothing built. Folds in the Multi Project mode proposal (`D:\code\sdk-forge\docs\multi-project-mode.md`, not in this repository).

Run several agents at once, see them all in one place, and keep their edits apart, as Cursor's Agents Window does, on the pieces this fork already has.

## The problem

One Continued window runs one session at a time. Subagents (S2, #307) run in parallel inside it, up to 3, but they share the parent's checkout and are short-lived: each returns one answer and is gone. There is no way to:

- start a second agent on another task while the first works, and switch between them;
- give two agents that edit the same repository separate checkouts;
- run one task on several models and keep the best result;
- carry out a plan's independent steps at the same time;
- keep one agent per repository or subproject, each with its own context, and send it work (the Multi Project mode request).

## What Cursor does

From Cursor's docs ([multi-agent](https://cursor.com/help/ai-features/multi-agent), [worktrees](https://cursor.com/docs/configuration/worktrees), [subagents](https://cursor.com/docs/subagents)) and its [Cursor 3 announcement](https://forum.cursor.com/t/cursor-3-worktrees-best-of-n/156507):

- **Agents Window**: one sidebar of every agent, across repositories and environments (local, worktree, cloud, SSH). Chats can be pinned. A task moves between local and cloud in one click.
- **Worktrees**: `/worktree <task>` runs the rest of a chat in its own checkout. The main checkout is untouched until `/apply-worktree`, or you commit and push from the worktree. `/delete-worktree` removes it.
  - `.cursor/worktrees.json` sets up a new worktree: `setup-worktree-unix`, `setup-worktree-windows`, or `setup-worktree` as the fallback. Each is a list of commands or a script path. `$ROOT_WORKTREE_PATH` points at the main checkout, for copying `.env` files.
  - Cleanup keeps at most `cursor.worktreeMaxCount` worktrees (25) per machine and runs every `cursor.worktreeCleanupIntervalHours`.
- **`/best-of-n sonnet,gpt,composer <task>`**: the same task on several models, each in its own worktree. It only compares; you apply the winner.
- **Subagents**: Markdown files with `name`, `description`, `model`, `readonly` and `is_background`, read from `.cursor/agents/`, `.claude/agents/` and `.codex/agents/`. Each has a clean context, returns a final message and can be resumed by its ID. Background ones log to `~/.cursor/subagents/`. They share the parent's checkout unless asked to use a worktree or a cloud VM; Cursor warns that a shared checkout lets them overwrite each other. Nesting is two levels.
- **`/multitask`** runs requests as parallel background subagents instead of queuing them. **Build in Parallel** on a plan runs independent steps at once and keeps dependent ones in order.

Others: Claude Code Desktop binds a session to a folder or worktree; Conductor, Vibe Kanban and Claude Squad make a card a worktree and an agent. `agent-ux-parity.md` covers the published guidance: one agent by default, parallel agents for independent work, not for tightly coupled edits, at about 15 times the tokens.

## What this fork has

| Piece                                                                     | Where                                                          | Use here                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Sessions with history, saved per workspace                                | `core/util/history.ts`, the GUI's session list                 | the rows of the panel                  |
| Queue and steering (Q1 to Q3, #301, #303, #305)                           | GUI and CLI                                                    | send to a running agent                |
| `cn serve` with steering (#310)                                           | `extensions/cli/src/commands/serve.ts`                         | a session that runs without a webview  |
| Subagents with a card each, 3 at once, cache stagger (S2, #307)           | `gui/src/util/subagents/runSubagent.ts`                        | parallel work inside one session       |
| Task lists and plan files with Build / Keep planning (F1, F4, #306, #308) | core, GUI, CLI                                                 | the plan that Build in parallel splits |
| A worktree helper that copies uncommitted and untracked changes           | `extensions/cli/src/commands/review/worktree.ts` (`cn review`) | the start of a worktree service        |
| Checkpoints per turn (#185)                                               | GUI                                                            | undo inside a worktree too             |
| Agent definitions that read `.claude/agents`                              | `core/subagents/`                                              | read `.cursor/agents` as well          |

VS Code's own Agents window cannot host Continued: its agents are built into VS Code, and an extension can only show sessions there through the proposed `chatSessionsProvider` (#297, `docs/customize/vscode-chat-and-agents.mdx`). So the panel lives in Continued's own view.

## Design

### 1. An Agents panel in Continued's sidebar

A list of agents, each a session:

- Its title, folder and branch or worktree.
- Its status: running, waiting for approval, queued, done, failed.
- Its model, tokens and cost.
- A line from its last turn.

Rows are grouped by folder, and they can be pinned. Opening a row switches the chat to that session. Approvals from any agent show on its row, so a waiting agent is visible without opening it. **New agent** starts a session with a prompt, a model and where to run: here, a new worktree, or in the background.

### 2. Agents that run without the webview

The webview shows one session at a time. Every other running agent is a `cn serve` process started by the extension, one per agent, with the session's model, mode and folder. The panel reads their status, and opening one attaches the chat to it. Sending uses the existing queue and steering endpoints (Q1, #310). The open session can still run in the webview as today.

An agent keeps its context between messages, because it is a session, not a subagent. This is what Multi Project mode asks for: one long-lived agent per repository or subproject.

### 3. Worktrees

A core worktree service, grown from `cn review`'s helper:

- **Create**: `git worktree add` on a new branch `continued/<slug>`, from HEAD plus uncommitted and untracked changes, under `~/.continue/worktrees/<repo>/<slug>`. Then it runs `.continue/worktrees.json`, or `.cursor/worktrees.json` when that is the only one, with the same keys and `$ROOT_WORKTREE_PATH`.
- **Apply**: merge the worktree's branch into the current branch. A conflict stops and shows the conflicted files, rather than patching silently. An agent's changes are committed on its branch at the end of each turn, so nothing is lost if a worktree is removed.
- **Discard**: remove the worktree and delete its branch.
- **Cleanup**: a machine-wide maximum count, oldest first, never one with uncommitted changes or a running agent.
- **One writer per checkout**: a second agent that would write in a checkout already being written to gets a worktree, or is refused. Read-only agents share.

### 4. Subagents in the background and in worktrees

Two frontmatter fields that agent files already carry, and that `core/subagents/definitions.ts` ignores today like any unknown field, get a meaning:

- `background: true` (Claude Code's name; Cursor's `is_background`) returns at once, and the parent reads the result later.
- `isolation: worktree` runs the subagent in its own worktree.

Cursor's `readonly` maps to the read-only tool set, and `.cursor/agents/` joins the definition paths.

### 5. Build in parallel

Plan files (F4) mark each step's dependencies. **Build in parallel** starts one agent per independent step, each in a worktree, and starts a dependent step only after the steps it depends on are applied. Steps tagged with a project folder go to that folder's agent (Multi Project mode). `/multitask` does the same for a list of requests typed together.

### 6. Best of N

`/best-of-n <models> <task>` starts the task once per model, each in a worktree. The panel shows the diffs side by side with tests and cost, and **Apply** takes one. An optional reviewer, the `reviewer` role from Track B, comments on the runs.

### 7. How many at once

- **Cloud models**: 3 to 5, as S2, with S2's staggered start so agents with the same prefix read one cache write.
- **Local servers**: as many as the server can serve.
  - Strata reports `concurrency.serving` in `/v1/status`. Its replicas route each conversation back to the replica that holds its cache.
  - llama.cpp lists one entry per slot in `/slots`.
  - Above that, agents queue rather than evict each other's cache. Strata holds one conversation per slot, so two agents on a one-slot Strata would rebuild each other's prompt every turn.

## Safeguards

- One writer per checkout, enforced by the worktree service.
- A token and cost budget per agent and per run of agents; a run stops when it is spent.
- An agent that makes no progress for N turns is marked blocked, not left looping.
- Approvals stay with the person: an agent never turns "ask" into "allow", as with S1.
- Stop on a row stops that agent; **Stop all** stops every agent.

## Phases

| Phase | Scope                                                                                                                                                    | Depends on |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1    | Agents panel: sessions with live status, grouping by folder, pin, open. Only the webview's session runs.                                                 | none       |
| A2    | Agents that run without the webview through `cn serve`; New agent; approvals on rows; Stop all.                                                          | A1         |
| A3    | Worktree service in core: create with `worktrees.json`, apply by merge, discard, cleanup, one writer per checkout. "Run in a new worktree" on New agent. | A2         |
| A4    | Subagents: `background` and `isolation: worktree`; `.cursor/agents`.                                                                                     | A3, S2     |
| A5    | Build in parallel from plan files, and `/multitask`.                                                                                                     | A3, F4     |
| A6    | Best of N with a side-by-side comparison.                                                                                                                | A3         |
| A7    | Concurrency from local servers (Strata `/v1/status`, llama.cpp `/slots`).                                                                                | A2         |
| A8    | Multi Project mode: a project registry (`.continue/projects.yaml` or discovered roots), one agent per project, steps tagged with a project.              | A2, A5     |

## Open questions

1. Is `cn serve` per agent the right host, or should the extension host run sessions in process? `cn serve` exists and already steers; in process avoids a second copy of config loading.
2. Where should worktrees live? `~/.continue/worktrees` keeps them out of the repository; Cursor does not document its path.
3. Apply by merge, or by squashing the branch into one change?
4. Should the panel also show the CLI's sessions, so `cn` agents and IDE agents are one list?
5. For Multi Project mode, should a subproject that shares git with its parent share the parent's writer lock?
