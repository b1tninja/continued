# Unreleased

## Privacy: Continuous no longer contacts Continue-operated servers

Earlier builds said they collect no telemetry, and the claim was not fully accurate. This change makes it accurate.

- **The built-in web search is gone.** The `search_web` tool and the `@web` context provider used to post the query, with the version, the operating system, a machine id and a key embedded in the code, to a Google Cloud Run proxy run by the upstream Continue project. That proxy is no longer contacted and the key is removed. `search_web` and `@web` now exist only if you set `CONTINUOUS_WEB_SEARCH_URL` to a search endpoint of your own (SearXNG-compatible JSON; optional `CONTINUOUS_WEB_SEARCH_KEY`). See `docs/customize/web-search.mdx`.
- **The docs crawler no longer has a remote path.** The `useLocalCrawling: false` setting that sent a site URL to the same proxy is ignored; sites are always fetched directly from the host you named.
- **Terminal agent metrics are opt-in.** They used to start whenever any `OTEL_*` variable was set. They now also need `CONTINUOUS_OTEL=1`, and the service name is `continuous-cli`. The old `CONTINUE_METRICS_ENABLED` and `CONTINUE_CLI_ENABLE_TELEMETRY` switches are no longer read.
- **A test now guards the claim.** `core/egress/egressAllowlist.vitest.ts` fails when a new hostname appears in source without an entry and a reason in `core/egress/egress-allowlist.json`.
