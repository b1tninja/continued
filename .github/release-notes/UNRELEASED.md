# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## Privacy: Continuous no longer contacts Continue-operated servers

Earlier builds said they collect no telemetry, and the claim was not fully accurate. This change makes it accurate.

- **The built-in web search is gone.** The `search_web` tool and the `@web` context provider used to post the query, with the version, the operating system, a machine id and a key embedded in the code, to a Google Cloud Run proxy run by the upstream Continue project. That proxy is no longer contacted and the key is removed. `search_web` and `@web` now exist only if you set `CONTINUOUS_WEB_SEARCH_URL` to a search endpoint of your own (SearXNG-compatible JSON; optional `CONTINUOUS_WEB_SEARCH_KEY`). See `docs/customize/web-search.mdx`.
- **The docs crawler no longer has a remote path.** The `useLocalCrawling: false` setting that sent a site URL to the same proxy is ignored; sites are always fetched directly from the host you named.
- **Terminal agent metrics are opt-in.** They used to start whenever any `OTEL_*` variable was set. They now also need `CONTINUOUS_OTEL=1`, and the service name is `continuous-cli`. The old `CONTINUE_METRICS_ENABLED` and `CONTINUE_CLI_ENABLE_TELEMETRY` switches are no longer read.
- **A test now guards the claim.** `core/egress/egressAllowlist.vitest.ts` fails when a new hostname appears in source without an entry and a reason in `core/egress/egress-allowlist.json`.
- What Continuous stores, sends and does not send is now written down in [PRIVACY.md](https://github.com/b1tninja/continuous/blob/main/PRIVACY.md).

## Hub assistants and the generated SDK client are removed

- The generated hub/API SDK client (`packages/continue-sdk`) is deleted, together with the terminal agent's API client service and the `CONTINUE_API_BASE` setting. The code no longer names a Continue-operated host, and `core/egress/egress-allowlist.json` has no entry for one.
- `--config owner/slug` (a hub assistant) now fails with "hub assistants are not supported; pass a config.yaml path". Pass a path to a `config.yaml`.

## File edits at IDGAF now reach outside the workspace

At File edits = IDGAF (the top level, also reached by `--auto`), the agent can create, edit and write files outside the workspace folder, in the editor, the terminal UI, headless `-p` and `serve`, with no prompt and no refusal. Before, a headless run refused such a write whatever the level, and the editor's exact edit tools treated an absolute path elsewhere as a file that does not exist.

- Each such write is listed in the audit trail as allowed by the level, with the resolved absolute path, and the tool result says `Wrote outside the workspace: <path>`.
- Lower levels are unchanged: Manual, Cautious and Automatic ask, Permissive holds it by the outside-paths protection.
- Still binding at IDGAF: the locked policy files, a tool switched off, an organisation ceiling and the `floor:` rules you wrote. Secret-file name checks inside the file tools, and the webview's own write guard (used for plan files), are not changed.
- Separate fix: an absolute path inside the workspace given to the new-file tool is now written where it says, not under a folder named after the drive.
