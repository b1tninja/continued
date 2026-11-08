# Parallel agents: an Agents panel, worktrees, Build in parallel

Last updated: 2026-11-07. Status: research and design; nothing built. Folds in the Multi Project mode proposal (`D:\code\sdk-forge\docs\multi-project-mode.md`, not in this repository, now superseded by this file). Multi-repo mode is a later phase, entered once plans can be dispatched and checkpoints are bound to a run or a repository ([Later](#later)).

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

Rows are grouped by folder, and they can be pinned. In a multi-root workspace each root is its own group, which is the first step towards a session, rules and checkpoints per root. Opening a row switches the chat to that session. Approvals from any agent show on its row, so a waiting agent is visible without opening it. **New agent** starts a session with a prompt, a model and where to run: here, a new worktree, or in the background.

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

Plan files (F4) mark each step's dependencies with Loop mode's syntax (#331, L6): indented `key: value` lines under a to-do, where `after: 1, 2` names the steps it waits for by their 1-based position in the list (stored as item ids on `TaskItem.after`). One syntax serves both features:

```markdown
- [ ] Add the worktree service
- [ ] Build the Agents panel
      after: 1
      folder: packages/agents
```

**Build in parallel** starts one agent per step whose `after:` steps are done, each in a worktree, and starts a dependent step only after the steps it waits for are applied. A step can name the folder it runs in with a `folder:` line, and goes to that folder's agent; across repositories this is [Later](#later). Loop mode's own keys (`check:`) are ignored here. `/multitask` does the same for a list of requests typed together.

### 6. Best of N

`/best-of-n <models> <task>` starts the task once per model, each in a worktree. The panel shows the diffs side by side with tests and cost, and **Apply** takes one. An optional reviewer, the `reviewer` role from Track B, comments on the runs.

### 7. How many at once

- **Cloud models**: 3 to 5, as S2, with S2's staggered start so agents with the same prefix read one cache write.
- **Local servers**: as many as the server can serve.
  - Strata reports `concurrency.serving` in `/v1/status`. Its replicas route each conversation back to the replica that holds its cache.
  - llama.cpp lists one entry per slot in `/slots`.
  - Above that, agents queue rather than evict each other's cache. Strata holds one conversation per slot, so two agents on a one-slot Strata would rebuild each other's prompt every turn.

### 8. Checkpoints bound to an agent run or a repository

Today's checkpoints are file snapshots per turn of one session (#185). With several agents in one workspace, restoring one turn would also undo files that another agent changed in the meantime. Cline turns checkpoints off in multi-root workspaces for this reason ([docs](https://docs.cline.bot/features/multiroot-workspace)).

Each checkpoint records the agent run that made it (a session or a subagent run) and the repository root its files are in. Restoring one restores only that run's files in that root, and refuses, listing the files, when another run has changed them since. In a worktree a checkpoint is a commit on the worktree's branch.

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
| A8    | Checkpoints bound to an agent run or a repository root: restore one run's files in one root, refuse when another run changed them since.                 | A3, A4     |

## Later

### Multi-repo mode

A project or workspace that spans several repositories, with one plan dispatched across them. It is worth building only on two things, so these are its entry condition:

1. **Dispatchable plans** (A5): plan-file steps carry `after:` and `folder:` lines (the syntax in §5), and Build sends them to agents.
2. **Checkpoints bound to a run or a repository** (A8), so restoring one repository's step does not touch the others.

With both in place:

- **A project registry.** It imports what is already there: the roots of an open `.code-workspace` and the git roots under the workspace folders, so adding a folder to the workspace makes it a project without listing it twice. A `.continue/projects.yaml` adds or names projects.
- **One long-lived session per repository**, with that repository's rules, model and checkpoints, writing only under its root.
- **One plan across repositories.** Each step runs in its repository's session or a worktree of it, and independent steps run in parallel.

Today the nearest thing is a multi-root workspace built folder by folder, where sessions and rules are workspace-wide and nothing is bound per root.

#### Workspace folders: a view, not the registry

Adding folders to the workspace is the right building block for looking at a project, but it should not be the person's job, and it should not be what makes a folder a project:

- **The first folder restarts extensions.** VS Code's API notes that `workspace.updateWorkspaceFolders` can terminate and restart the running extensions, the caller included, for example when the first workspace folder is added, removed or changed (the deprecated `rootPath` follows it). Moving from a single-folder window to a multi-root one is reported to restart them too, since the workspace changes (microsoft/vscode#69335). A restart would cut off every agent the extension runs.
- **Every root costs.** Each one adds file watchers, search scope and language servers. Slowdowns with many roots are reported, but VS Code documents no limit.
- **Nested repositories.** When the opened folder is itself a git repository, the repositories inside it are reported to be hidden from Source Control (microsoft/vscode#327119; `git.repositoryScanMaxDepth` defaults to 1). A folder of many repositories is exactly the case that leads people to add them one by one.

So:

- The registry is kept apart from the workspace folders. Agents run through `cn serve` on any registered path, and a folder joins the workspace only when the person wants to see it.
- **Open project** and **Close project** add or remove a root with `updateWorkspaceFolders`, appending and removing but never touching the first folder. A stable first root, the workspace's hub, means opening or closing a project never restarts the extension host or its agents.
- A project's root is closed again when its sessions finish, to keep the watcher and language-server cost down.
- The registry finds git roots itself, including repositories nested inside another, which Source Control may not show.

#### A rolling plan

Build in multi-repo mode is not fire-and-forget. The plan is looked at again as work completes:

- **When**: a step's task list completes; a session reports done, blocked or failed; a run turns up new work, such as a failing test, a bug or a missing prerequisite.
- **Where**: a re-planning pass in the overview's own context, read-only, never inside the sessions doing the work, which carry on.
- **What it reads**: each project's step statuses and task lists, and what is left according to a next-work provider: a command or MCP tool that returns what remains, such as ROADMAP rows, issues or plan-file todos. "What is left" comes from that answer, not from the model's memory.
- **What it produces**: a plan diff, with steps added, dropped, reordered or re-scoped and a reason for each. The person accepts it as with Build / Keep planning today, or Auto mode applies it within limits. Each accepted diff is saved in the plan file, so the plan keeps its history.

## Open questions

1. Is `cn serve` per agent the right host, or should the extension host run sessions in process? `cn serve` exists and already steers; in process avoids a second copy of config loading.
2. Where should worktrees live? `~/.continue/worktrees` keeps them out of the repository; Cursor does not document its path.
3. Apply by merge, or by squashing the branch into one change?
4. Should the panel also show the CLI's sessions, so `cn` agents and IDE agents are one list?
5. For multi-repo mode, should a subproject that shares git with its parent share the parent's writer lock and checkpoints?
