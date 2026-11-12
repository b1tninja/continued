# Privacy

> **Unofficial, community-maintained fork.** Continuous is not affiliated with, endorsed by, or supported by Continue Dev, Inc. This page describes this fork only.

Continuous runs on your machine. It has no account, no server of ours and no analytics. This page says what it keeps, what it sends and how to check.

Some statements below describe the product **after** the egress fix ([#627](https://github.com/b1tninja/continuous/pull/627)). Builds 2.12.0 and 2.12.1 do not match them: see [Older builds](#older-builds).

## Stored on your machine

Everything lives under the global folder, `~/.continuous` (copied from `~/.continue` on first start; the old folder is left alone). Set `CONTINUOUS_GLOBAL_DIR` to move it.

- **Settings, models and rules**: `config.yaml`, `permissions.yaml` (your tool permission rules).
- **Chat sessions and history**: `sessions/`, plus `dev_data/` event files and `logs/`.
- **The audit trail** of tool decisions: `audit/`, with `audit-index.json` and, in shadow mode, `shadow-spend.jsonl`. On by default, masked and capped (30 days, 20 MB a file). Turn it off with `audit.enabled: false` in `config.yaml` or `CONTINUE_AUDIT=off`.
- **Checkpoints** of agent file edits, and plan files in your own project.

New session and log files are written owner-only, and secrets the scanner recognises are masked before they reach disk. This is a safety net, not a guarantee: do not paste secrets into prompts.

**Retention.** Nothing deletes by itself. `continuous clean` lists, and with `--yes` deletes, sessions older than 30 days, logs older than 14 days and `dev_data` older than 90 days; `--older-than 7d` sets one age for all. It does not securely erase: SSDs, snapshots and backups can keep copies. The audit trail has its own retention setting (30 days by default, `audit.retentionDays`).

## Sent to the model providers you choose

Your messages, the files and tool output the agent reads, and the conversation so far go to the endpoint you configured for each model, under that provider's own terms. Only hosts you configured are used. Local providers (Ollama, LM Studio) stay on your machine.

## Not sent

- **No telemetry.** No usage data, crash reports or machine id go to us or to anyone. There is no analytics SDK in the code.
- The terminal agent has an OpenTelemetry metrics exporter. It is **off** unless you set `CONTINUOUS_OTEL=1` and an `OTEL_*` exporter or endpoint yourself; then it sends counters (such as tokens and cost) and host details to the destination you named.
- The update check is a stub; it contacts nothing.
- Terminal commands the agent runs start with a scrubbed environment (secret-looking variables removed).

## Contacts a third party only if you set it up

- **Web search**: the `search_web` tool and `@web` exist only if you set `CONTINUOUS_WEB_SEARCH_URL` to a search endpoint you run or choose (optional `CONTINUOUS_WEB_SEARCH_KEY`, sent to that endpoint only). See [web search](docs/customize/web-search.mdx).
- **MCP servers** you add, and their sign-in pages.
- **Pages you name**: `@url`, the `fetch_url` tool and docs indexing fetch the sites you point them at, directly from your machine.
- **Docs on GitHub**: a docs entry on github.com uses the GitHub API.
- **Chromium**: one download, only if you accept the install prompt.

The embeddings model is bundled; nothing is downloaded from Hugging Face at run time.

## Check it yourself

- `core/egress/egressAllowlist.vitest.ts` fails when source code names a host that is not in `core/egress/egress-allowlist.json` with a reason, and denies `*.run.app` and `*.continuedev.com`. It is a static check of the source, not a capture of live traffic.
- `continuous doctor network`, if present in your build, reports the outbound paths. It depends on [#638](https://github.com/b1tninja/continuous/pull/638).
- The code is open. A firewall or proxy log is the final word.

One Continue-operated hostname remains in the source: `api.continue.dev`. It is the default value of the API base setting (`CONTINUE_API_BASE`) in the terminal agent, the default of the generated SDK client in `packages/continue-sdk`, and a literal in tests and one comment. The terminal agent no longer calls it for remote agent ids, storage sync, agent status or metadata, artifact upload, PR checks or secret sync: that code was removed. No `continue.dev` or `docs.continue.dev` link is left in the terminal agent's messages. This is a reading of the source, not a capture of traffic. The hub config-loading code that still takes an API client (`configLoader`, `ApiClientService`) was not traced to the end here, and removing it together with the SDK client is the next step. Nothing in the default local path fetches the host, including a first run with no `config.yaml`: the hosted default config that upstream fetched for unconfigured users was removed, so that run makes no connection.

## Where secrets are kept

API keys are not kept in the repository. In VS Code they are stored encrypted in the extension's storage, with the key in VS Code's secret storage. In `config.yaml` you can refer to a key by name (`${{ secrets.NAME }}`) or an environment variable instead of writing it down. Do not commit `config.yaml` with keys in it; `continuous secrets scan` checks files and history.

## Older builds

Builds 2.12.0 and 2.12.1 sent web search queries and, for sites with `useLocalCrawling: false`, docs URLs to a proxy run by the upstream Continue project, with the extension version, operating system, a machine id and a key embedded in the code. They also told the model to add a `Co-Authored-By: Continue` trailer to commits. Upgrade to a release that includes the egress fix and the attribution fix ([#626](https://github.com/b1tninja/continuous/pull/626)).

## Reporting a privacy or security problem

This fork's GitHub Issues are turned off. Report security-sensitive problems privately through GitHub private vulnerability reporting: <https://github.com/b1tninja/continuous/security/advisories/new>. General privacy questions use the same channel until a project mailbox exists. Please do not post vulnerability details or secrets in a public pull request.

Changes to this page are made by pull request; the history is in git.
