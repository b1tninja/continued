# Roadmap

Last updated: 2026-11-03 (at `origin/main` 880f72bd4, after #125). Track C status updated after the safeguards work; Track D (hooks) and Track E (upstream signals) added. Real-world cache data is in `cache-real-world-data.md`.

This is the place to check what is done, what is in flight and what comes next. `fork-plan.md` stays as the original design record (why we forked, scope, risks, licensing, CI). Detailed plans for new work live next to this file.

## Shipped

PR numbers are from `b1tninja/continued`, read from `git log` and `gh pr list`. Nothing here is aspirational.

| Area                  | What works now                                                                                                                                                                     | PRs                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Remote MCP servers    | OAuth sign-in for `streamable-http` and `sse`; tokens kept in the IDE's secret storage                                                                                             | #7, #14                              |
| Enterprise TLS        | Proxy, CA bundle and system CA store for MCP servers and for Bedrock requests                                                                                                      | #5, #8                               |
| Amazon Bedrock        | Add-model wizard with a connection test and model discovery; bearer-token auth for API keys; clearer access-denied hint; one model list across the standard and Mantle endpoints   | #2, #81, #90 (includes #91)          |
| Bedrock Mantle        | `bedrock-mantle` provider                                                                                                                                                          | #4                                   |
| Models                | Adaptive thinking for Claude 4.6+; live model lists in the model pickers                                                                                                           | #87                                  |
| Per-mode models       | `modeModels:` in config.yaml (one model and a reasoning effort per Chat / Plan / Agent mode); the mode menu shows which model each mode uses                                       | #3                                   |
| Branding              | "Continued" in user-visible VS Code labels                                                                                                                                         | #12                                  |
| Build, CI and tooling | VSIX build time limit, CI cost cuts, e2e against VS Code 1.144, ripgrep from npm, ESLint 10 flat configs, TypeScript 7, vitest 5, core binary built with `@yao-pkg/pkg` on Node 22 | #62-#64, #80-#84, #86, #88, #89, #93 |

## In progress

| Item                                 | State                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fork install guide, README, new icon | PR #92, open, branch `chore/rebrand-and-install-docs`                                                                                                                                                                                                                                                                                                  |
| Missing-secret indicator (A0)        | PR #98, open. Detection, toolbar and gear indicators, panel with Open .env / Open config line / Copy name. Tested at unit and component level only; not yet clicked through in a real editor.                                                                                                                                                          |
| Session cost tracking                | Branch `feat/session-cost-tracking` exists but has no commits of its own yet (same commit as `main`). No plan written yet.                                                                                                                                                                                                                             |
| Prompt caching controls (Track C)    | C0 to C3 and C6 built on branches `feat/cache-visibility`, `feat/cache-toolbar` and `feat/cache-safeguards`, stacked, PRs to follow. Toolbar menu, Auto lifetime, Bedrock cache fix (confirmed live), and warnings before expensive actions, including resuming a saved session. Default stays off. See `prompt-caching.md` and `cache-safeguards.md`. |
| Dependency updates                   | Open Dependabot PRs (for example #65-#69, #71-#79, #85). Merge in groups; rerun the CI gates after major bumps.                                                                                                                                                                                                                                        |

## Next

Three independent tracks. They share no code, so different people can build them in parallel. Each track is a series of small PRs, one concern per PR.

### Track A: model and provider setup

Plan: [`model-config-ux.md`](./model-config-ux.md)

Problem: the setup wizard cannot be reopened to edit a configuration; each provider contributes exactly one chosen model; you cannot choose a set of models per mode to switch between quickly; and a config that references a secret not set on this machine fails with an unrelated authentication error instead of pointing at the missing key.

| PR  | Scope                                                                                                                                                                                                                       | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A0  | Detect `${{ secrets.* }}` references that are not set on this machine; show a warning indicator on the toolbar triangle and the model gear, with a popover to open `.env` or the config line; stop sending the literal text | none       |
| A1  | Schema and core: `modeModels.<mode>.models` list, comment-preserving YAML edits, new setup messages, secret-storage lookup                                                                                                  | none       |
| A2  | The chat model picker and `Cmd+'` follow the current mode's list                                                                                                                                                            | A1         |
| A3  | Models tab: checkbox table (Chat / Plan / Agent) with a default per mode, plus a Providers card                                                                                                                             | A1         |
| A4  | One reusable setup flow (credentials, model checklist, review) behind the onboarding card, "Manage models", and a command; adds "Enter key" to the A0 popover                                                               | A1         |

### Track B: tool auto-approval and Auto mode

Plan: [`tool-auto-approval.md`](./tool-auto-approval.md)

Problem: tool approval is a three-way switch per tool, stored in the webview rather than in config. There is no way to say "allow `npm test`, ask for `git push`, never read `.env`", MCP tools cannot be told apart, and nothing judges a command by its effect (for example, whether it touches production).

| PR  | Scope                                                                                                                                             | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B1  | `toolPermissions` rules in config.yaml, a rule engine in core, named refusal reasons, protected paths                                             | none       |
| B2  | Approval selector (Manual / Auto-approve / YOLO), Cline-style category toggles, per-server MCP switches, "Always allow"                           | B1         |
| B3  | A `reviewer` model role and the optional "Auto" mode that uses it, with deny-and-continue and refusal caps, behind an experimental setting        | B1         |
| B4  | Evaluation set; confirm or change the suggested reviewer defaults; documentation; the experimental flag is removed only if the quality bar is met | B3         |

### Track C: prompt caching controls

Plan: [`prompt-caching.md`](./prompt-caching.md) and [`cache-safeguards.md`](./cache-safeguards.md)

Problem: cached prompts expire after 5 minutes by default, so a session that pauses for a long command or a long read re-reads its whole history at full price. There is no switch for it, no way to choose the lifetime, no cost shown, and two placement bugs mean some sessions do not hit the cache at all. Independent of Tracks A and B.

| PR  | Scope                                                                                                                                                                                                                                                                                                                                    | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C0  | Measure: Bedrock usage, the 5m/1h write split, 1-hour price and missing Claude models in the cost table, hit rate against API counts, miss-cause report                                                                                                                                                                                  | none       |
| C1  | Fix cache marker placement for Agent loops (tool results) and Bedrock's rewritten messages                                                                                                                                                                                                                                               | C0         |
| C2  | One policy function, `cacheBehavior.ttl`, `ttl` sent on Anthropic, Vertex, Bedrock and OpenRouter; default stays off                                                                                                                                                                                                                     | C1         |
| C3  | Toolbar menu (Auto / 5 minutes / 1 hour / Off), warm-or-expired tooltip, switch-cost notice, usage panel                                                                                                                                                                                                                                 | C2         |
| C4  | Default on for Claude models with Auto. A week of real traffic is in `cache-real-world-data.md` and supports it; the default is the owner's decision                                                                                                                                                                                     | C3         |
| C5  | Documentation for the new fields and a page on cache lifetime and cost                                                                                                                                                                                                                                                                   | C2         |
| C6  | Cache and cost safeguards, built: cold-cache notice (also on resuming a saved session), caching-off notice, model and mode switch warnings, miss notice that names the cause, large-message notice, notes on tool and MCP changes, context meter by size, Claude 5 prices, Global Bedrock hint (PR to follow, see `cache-safeguards.md`) | C3         |
| C7  | Resume notice for sessions saved before C6 (they have no cache record); count @-attached files in the large-message notice                                                                                                                                                                                                               | C6         |
| C8  | Keep the cache when rules change the system prompt: send changes as an appended system message on the models that accept it (Opus 4.8, Sonnet 5.5, Opus 5.5, Haiku 5.5). Needs live tests on each provider                                                                                                                               | C6         |
| C9  | Vertex and OpenRouter prices for Claude 5.x, with the Regional premium on Google Cloud                                                                                                                                                                                                                                                   | C6         |
| C10 | Evaluate tool result clearing and compaction suggestions on Continue's own data; session cost in the toolbar and a "spent on cold rewrites" line in the usage panel                                                                                                                                                                      | C6         |

### Track D: hooks

Plan: [`hooks-wiring.md`](./hooks-wiring.md). Comparison with other tools: [`feature-comparison.md`](./feature-comparison.md)

Problem: the CLI has a complete hooks system (17 events, command and HTTP handlers, Claude Code compatible settings files) that nothing calls, so hook files are read and ignored. Wiring it also needs fail-closed behaviour and a trust check, because project hook files run shell commands.

Status: D1 to D3 are built on branch `feat/hooks-runner-fail-closed` (PR to follow). The trust check has no environment variable, because the CLI loads a `.env` from the working directory. See `hooks-wiring.md`.

| PR  | Scope                                                                                                                                             | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | Fix the runner: timeouts and other failures block by default, `onError` per hook, `deny` beats `allow`, `prompt` and `agent` handlers fail closed | none       |
| D2  | Trust check for project hook files, user-level files always load                                                                                  | D1         |
| D3  | Wire `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `UserPromptSubmit` into the CLI, with `updatedInput` re-running `preprocess`           | D1, D2     |
| D4  | Docs page `docs/cli/hooks.mdx`; remaining events (`Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`, `PermissionRequest`)        | D3         |
| D5  | Hooks in the IDE: share the runner with `core`                                                                                                    | D3         |

### Track E: bugs and requests from upstream

Plan: [`upstream-signals.md`](./upstream-signals.md)

Problem: upstream no longer merges fixes, but its open issues and pull requests show bugs that still apply here. Several were confirmed by reading this fork's code (U1 to U4); the rest need reproducing first.

| PR  | Scope                                                                                                                                             | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| E1  | Subagents keep the parent's permission policy; Bash tool and hook runner stop waiting on detached children; address check on URL fetch (U1 to U3) | none       |
| E2  | Pruning keeps the user's turn; OpenAI cost counts cached tokens, with current prices (U4, U9)                                                     | none       |
| E3  | Reproduce, then fix: "Automatic" terminal policy and the edit-tool overwrite (U5, U6)                                                             | none       |
| E4  | Proxy port matching, SSE comment lines, Windows `npx` for MCP servers (U7, U8, U10), alongside the MCP review                                     | none       |
| E5  | Evaluate an ACP mode in `cn` for editors we do not ship (U11)                                                                                     | none       |

### Track F: task planning

Plan: [`task-planning.md`](./task-planning.md)

Problem: the CLI's `Checklist` tool keeps the list only as tool calls in the conversation, so compaction, pruning or a new session can lose the plan. The IDE has no task list at all. Other harnesses keep the list as state outside the transcript and put it back in front of the model each turn.

| PR  | Scope                                                                                                                    | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| F0  | Measure where the list should sit in the request, using the live Bedrock cache test; confirm a free CLI key              | none       |
| F1  | `TaskPlan` in core and on `Session`; `TaskList` tool with a `Checklist` alias; the list in each request; summary prompts | F0         |
| F2  | CLI progress strip, expand key, keyboard editing                                                                         | F1         |
| F3  | IDE: tool, session field, list under the input, in-place editing                                                         | F1         |
| F4  | Plan files in `.continue/plans/`, seeding the list                                                                       | F1         |
| F5  | New session with this plan; optional block-completion setting                                                            | F1, C6     |
| F6  | Subtasks with their own conversation                                                                                     | F1, E1     |

## Later

Carried over from `fork-plan.md` section 4.7, item 4. None started:

- Checkpoints for file edits, so an Agent run can be rolled back.
- A global rules toggle per mode.
- Context-window and cost display per model (see the session cost tracking branch above).
- Import of Cline's MCP settings file, so servers are not configured twice.
- Warn about other costly habits that need Continue's own data first: repeated failed edits in one session, a large model for a small task. Candidates are listed under "Not built" in `cache-safeguards.md`.

## Open decisions

| Decision                                                   | Default used for planning                                                                                                                          | Needs an owner |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Where per-mode model lists live                            | `modeModels.<mode>.models` in config.yaml                                                                                                          | no             |
| Which config file GUI setup edits                          | the global `~/.continue/config.yaml` only (other profiles: open file)                                                                              | no             |
| API key storage                                            | a user setting in the setup flow; default secure storage, else `~/.continue/.env` (see `model-config-ux.md` section 4.5)                           | no             |
| Where tool-approval rules live                             | config.yaml under `toolPermissions`                                                                                                                | no             |
| Reviewer model for Auto mode                               | a user setting: a new `reviewer` model role, unset by default, so Auto stays unavailable until one is chosen (`tool-auto-approval.md` section 7.3) | no             |
| Distribution channel for the `.vsix` (fork-plan section 6) | open                                                                                                                                               | yes            |

## How to use this file

- Update the "Last updated" line and move rows between sections in the same PR that changes their state.
- Add a PR number only after the PR exists. Do not list planned work as shipped.
- A new plan goes in `plans/<topic>.md` and gets a row under "Next".
