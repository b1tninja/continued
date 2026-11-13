# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## Privacy: Continuous no longer contacts Continue-operated servers

Earlier builds said they collect no telemetry, and the claim was not fully accurate. This change makes it accurate.

- **The built-in web search is gone.** The `search_web` tool and the `@web` context provider used to post the query, with the version, the operating system, a machine id and a key embedded in the code, to a Google Cloud Run proxy run by the upstream Continue project. That proxy is no longer contacted and the key is removed. `search_web` and `@web` now exist only if you set `CONTINUOUS_WEB_SEARCH_URL` to a search endpoint of your own (SearXNG-compatible JSON; optional `CONTINUOUS_WEB_SEARCH_KEY`). See `docs/customize/web-search.mdx`.
- **The docs crawler no longer has a remote path.** The `useLocalCrawling: false` setting that sent a site URL to the same proxy is ignored; sites are always fetched directly from the host you named.
- **Terminal agent metrics are opt-in.** They used to start whenever any `OTEL_*` variable was set. They now also need `CONTINUOUS_OTEL=1`, and the service name is `continuous-cli`. The old `CONTINUE_METRICS_ENABLED` and `CONTINUE_CLI_ENABLE_TELEMETRY` switches are no longer read.
- **A test now guards the claim.** `core/egress/egressAllowlist.vitest.ts` fails when a new hostname appears in source without an entry and a reason in `core/egress/egress-allowlist.json`.
- What Continuous stores, sends and does not send is now written down in [PRIVACY.md](https://github.com/b1tninja/continuous/blob/main/PRIVACY.md).

## Loop mode: it goes on when Plan edits and Questions are permissive

- A loop no longer stops on a plan card or in the Questions panel when you chose not to be asked. At Plan edits Automatic, Permissive or IDGAF a re-plan (a repair, a replaced check, added or dropped to-dos) is accepted and the next round starts. Before, a re-plan that replaced a failed item's check always waited, even at IDGAF.
- At Questions Automatic, Permissive or IDGAF a question the agent asks, and a decision in a plan, is answered by the system: the option labelled `(recommended)`, else the first, else "No one is available to answer; use your best judgment and state the assumption". The record says `system` and names the setting. At Manual and Cautious nothing changes.
- The loop panel shows one non-blocking line for each, such as `Plan updated: 11 kept, 1 added, 1 dropped; check of item 1 replaced` and `Auto-answered: <question> -> <answer>`. The extension, `cn` and `cn serve` share one rule. See "What Plan edits and Questions do for a loop" in the Permissions page docs.

## Questions at IDGAF: nothing asks

- At Questions IDGAF no question waits for you any more, outside a loop too. `cn`'s AskQuestion (terminal UI, `-p`, `serve`), a plan's decisions made in Plan mode, held questions left over when you move a loop to IDGAF, an item over its limit under Suggest and an MCP server's elicitation are all answered by the system. A call that a loop would hold for approval is refused instead of held, and a call at an IDGAF-level area that still asked (a command that hides what it runs) is refused with its reason.
- The answer is the option labelled `(recommended)`, else the plan's pick, else the first option, else "No one is available to answer; use your best judgment and state the assumption", recorded as `system` with `Questions: IDGAF` and shown as `Auto-answered: <question> -> <answer>`. Your own "you decide" list no longer applies at IDGAF. MCP elicitation takes the server's defaults, or is declined when a field has none or asks for a secret. Permissive, Automatic, Cautious and Manual are unchanged.

## Hub assistants and the generated SDK client are removed

- The generated hub/API SDK client (`packages/continue-sdk`) is deleted, together with the terminal agent's API client service and the `CONTINUE_API_BASE` setting. The code no longer names a Continue-operated host, and `core/egress/egress-allowlist.json` has no entry for one.
- `--config owner/slug` (a hub assistant) now fails with "hub assistants are not supported; pass a config.yaml path". Pass a path to a `config.yaml`.

## Behaviour changes

- The YOLO level is now called IDGAF; existing settings keep working. A saved `yolo` (settings, loops, `--policy yolo`) is read as `idgaf`, and nothing writes the old name.
- **An MCP server's `readOnlyHint` is believed only for a server you trust.** Before, any server not defined inside the open folder could mark a tool read-only, which let the tool run without asking and kept it from counting as a send in the tainted-session rule. Now the hint counts only for a server you named `trusted` under `mcpServers` in your own `permissions.yaml`, a server written inline in your own `config.yaml` (the CLI: when it runs on `~/.continue/config.yaml`), or a server defined by a file in your global folder. A hint from a server that came with the open folder, an agent file, a `--mcp` flag or any other source is ignored: the tool asks like any other tool, and counts as a send. If a third-party server's read-only tools stopped running silently after you upgraded, add the server under `mcpServers:` as `trusted`.
- **Two MCP tools never share a name.** In the CLI, a tool keeps its bare name unless another connected server offers the same name or a built-in tool has it; those are offered as `<server>_<tool>`. A call runs on the server its tool was listed under. Before, it ran on whichever connected server had that name first, so the card you approved and the server that ran could differ. A call by a bare name that two servers offer is refused. In the extension and the CLI, tools whose composed names collide (server `a` with tool `b_c` and server `a_b` with tool `c` both gave `a_b_c`) are all renamed with a short stable suffix. Names that do not collide are unchanged, so existing rules keep matching. A saved rule written with a bare name for a tool that is now qualified no longer matches it and the tool asks.

## File edits at IDGAF now reach outside the workspace

At File edits = IDGAF (the top level, also reached by `--auto`), the agent can create, edit and write files outside the workspace folder, in the editor, the terminal UI, headless `-p` and `serve`, with no prompt and no refusal. Before, a headless run refused such a write whatever the level, and the editor's exact edit tools treated an absolute path elsewhere as a file that does not exist.

- Each such write is listed in the audit trail as allowed by the level, with the resolved absolute path, and the tool result says `Wrote outside the workspace: <path>`.
- Lower levels are unchanged: Manual, Cautious and Automatic ask, Permissive holds it by the outside-paths protection.
- Still binding at IDGAF: the locked policy files, a tool switched off, an organisation ceiling and the `floor:` rules you wrote. Secret-file name checks inside the file tools, and the webview's own write guard (used for plan files), are not changed.
- Separate fix: an absolute path inside the workspace given to the new-file tool is now written where it says, not under a folder named after the drive.
