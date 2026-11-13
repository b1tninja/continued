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

## File edits at IDGAF now reach outside the workspace

At File edits = IDGAF (the top level, also reached by `--auto`), the agent can create, edit and write files outside the workspace folder, in the editor, the terminal UI, headless `-p` and `serve`, with no prompt and no refusal. Before, a headless run refused such a write whatever the level, and the editor's exact edit tools treated an absolute path elsewhere as a file that does not exist.

- Each such write is listed in the audit trail as allowed by the level, with the resolved absolute path, and the tool result says `Wrote outside the workspace: <path>`.
- Lower levels are unchanged: Manual, Cautious and Automatic ask, Permissive holds it by the outside-paths protection.
- Still binding at IDGAF: the locked policy files, a tool switched off, an organisation ceiling and the `floor:` rules you wrote. Secret-file name checks inside the file tools, and the webview's own write guard (used for plan files), are not changed.
- Separate fix: an absolute path inside the workspace given to the new-file tool is now written where it says, not under a folder named after the drive.

## Headless runs: an event stream

### New

- `continuous -p --format stream-json` prints one JSON object per line: `init`, `usage` per model request, `message`, `tool_use`, `tool_decision` (allowed, asked or refused, and by what), `tool_result`, `run_limit`, `error`, and a last `result` line with the exit code, counts and cost. The stream is versioned (`schemaVersion: 1`), checked against a JSON Schema in `extensions/cli/spec/stream-json.schema.json`, and every field goes through the audit masker; tool output is cut at 4000 characters. Nothing else is written to stdout in this mode. See [Headless output](https://github.com/b1tninja/continuous/blob/main/docs/cli/headless-output.mdx).
- `continuous -p --output-schema <file>` checks the final answer against a JSON Schema and exits 6 when it does not match. The schema is read before the first request (an unusable file exits 2) and is not sent to the model. See [Exit codes](https://github.com/b1tninja/continuous/blob/main/docs/cli/exit-codes.mdx).
- The exit codes of a headless run are documented in one table, which a test compares with the code: 0 success, 1 error, 2 config, 3 secrets found, 4 provider, 5 refused, 6 output schema, 20 to 22 run limits, 130 interrupted.

### Behaviour changes

- A headless run whose model call fails (network, a bad key, a rate limit, an HTTP error from the provider, a context that is too long) now exits **4** instead of 1.
- A headless run whose configuration gives it no usable model, or that sets `--max-budget-usd` on a model with no price, now exits **2** instead of 1, the code a broken hooks or permissions file and `serve`'s refusal to start already use.
- A headless run exits **5** instead of 1 when a `UserPromptSubmit` hook blocks the prompt, and instead of 0 when the turn ended at the refusal cap because tool calls kept being refused.

## Terminal agent: export a session as a masked transcript

### New

- `continuous export <session> [--format md|html] [--out file] [--force]` and `/export [path]` in the terminal UI write a session as Markdown (or one self-contained HTML page): the title and a date, your messages, the replies and the tool calls, every text through the audit masker, tool output cut at 2000 characters, reasoning left out unless `--reasoning`, and no system prompt, attached files, paths or session id. An existing file is not replaced without `--force`. See [Export a session](https://github.com/b1tninja/continuous/blob/main/docs/cli/export.mdx).

### Behaviour changes

- `/export` with no argument now writes the masked Markdown transcript. The session JSON that `/import` reads moved to `/export --json`.

## Terminal agent: attention notifications

### New

- The terminal UI can ring the terminal bell and/or raise an OS notification (Windows toast, macOS Notification Center, `notify-send`) when a tool call waits for approval, a question waits for an answer, or a turn of at least 30 seconds has finished. Off by default; turn it on with `notifications` in your own `settings.json` (a project cannot). The notice names the tool and the state only, repeats within 10 seconds are dropped, nothing goes over the network, and a missing notifier fails silently. Focus is not detected yet, so `when: "unfocused"` acts as `always`. See [Attention notifications](https://github.com/b1tninja/continuous/blob/main/docs/cli/notifications.mdx).
