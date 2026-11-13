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
- **The terminal agent's "always allow" no longer rewrites a `permissions.yaml` it could not load.** Before, when the file existed but was malformed or had a key the loader does not know, the next "always allow" replaced it with a single `allow:` list, and the `floor:` rules, the `exclude:` (Never) rules, the levels and the comments were gone. Now nothing is written, and the chat says `Not saved: <file> <what is wrong>, and writing now would replace it. Fix the file, then choose "always allow" again.` The call in hand is still allowed once. On a file that loads, the rule is added as one line and the rest of the file is kept as written: comments, key order, levels, `floor:` and keys this build does not know. Not kept: `allow: []` written on one line becomes a list with one rule per line.
- **"Always allow" keeps the flags the session was started with.** Before, the first "always allow" in a session reloaded the rules from `permissions.yaml` and the defaults only, so a tool removed with `--exclude` came back and `--ask` and `--allow` stopped outranking the file. The flags now apply for the whole session.
- **File writes are a temp file and a rename.** The terminal agent's Edit, MultiEdit and Write tools, the plan file, and both writers of `permissions.yaml` used to write the destination in place, so a kill, a crash or a full disk during the write could leave half a file. They now write `.<name>.<pid>.<n>.tmp` beside the destination and rename it over. The file's permission bits and line endings are kept and a symbolic link is written through. What is different for you: a hard link to an edited file keeps the old contents; the file's owner becomes the user running the agent; on Windows, when another program holds the file open, the rename is retried for about 0.15 seconds and then the file is written in place as before.
- **A damaged session file is set aside, not replaced.** Before, opening a session whose file did not parse gave an empty chat under the same id, and the next message saved over the damaged file. Now the file is renamed to `<id>.corrupt-<time>.json` in the sessions folder and you are told once where it is (a notification in the extension, a line in the chat or on stderr in the terminal agent). A session file that cannot be read at all (permissions, a lock) is left where it is and the session is not opened. `continuous clean` prunes the set-aside files by age with the other session files.
- **`cn --resume` says when it did not resume your last session.** Before, an unreadable newest session was skipped in silence and the one before it was resumed. Now the damaged file is set aside as above and one line says so: `The newest session could not be read (kept at <path>). Resumed the one before it: "<title>" from <folder>.`
- **A `config.yaml` that does not load names the file and the reason.** Before, the terminal agent printed `Failed to load config:` followed by `[object Object]`, and for a YAML syntax error it printed the offending lines of the file, which can include an API key. Now: `Failed to load config <file>: <reason> at line <n>, column <m>`, with one line per problem when there are several, and never the file's lines.
- **A session that cannot be saved says so.** Before, a full disk or a sessions folder that cannot be written was reported in `cn.log` only. Now the first failed save of a session shows one line: `This session is not being saved (<folder>): <reason>. The conversation continues in memory and is saved again as soon as a write succeeds.` It is a line in the chat in the terminal UI and a line on stderr in `cn -p` and `cn serve`; stdout is unchanged.

## File edits at IDGAF now reach outside the workspace

At File edits = IDGAF (the top level, also reached by `--auto`), the agent can create, edit and write files outside the workspace folder, in the editor, the terminal UI, headless `-p` and `serve`, with no prompt and no refusal. Before, a headless run refused such a write whatever the level, and the editor's exact edit tools treated an absolute path elsewhere as a file that does not exist.

- Each such write is listed in the audit trail as allowed by the level, with the resolved absolute path, and the tool result says `Wrote outside the workspace: <path>`.
- Lower levels are unchanged: Manual, Cautious and Automatic ask, Permissive holds it by the outside-paths protection.
- Still binding at IDGAF: the locked policy files, a tool switched off, an organisation ceiling and the `floor:` rules you wrote. Secret-file name checks inside the file tools, and the webview's own write guard (used for plan files), are not changed.
- Separate fix: an absolute path inside the workspace given to the new-file tool is now written where it says, not under a folder named after the drive.
