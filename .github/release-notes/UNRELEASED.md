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

## Model lists are downloaded when you ask, not when a screen opens

- Provider setup no longer contacts `ollama.com` or `openrouter.ai` when it opens. Ollama asks "Download the latest model list from ollama.com?"; OpenRouter asks "Pull the latest model information from OpenRouter?" with **Pull now**, **Not now** and **Don't ask again** (saved as `modelCatalog: never` in `config.yaml`). **Refresh** stays on the model step.
- The OpenRouter list (names, context sizes, per-token prices) is kept on this computer, dated, in `model-catalog/openrouter.json` in the global folder, and read from there afterwards. If the site cannot be reached, the list you already had stays.
- The details are in [PRIVACY.md](https://github.com/b1tninja/continuous/blob/main/PRIVACY.md) and the OpenRouter provider page.

## OpenRouter prices in cost figures and budgets

- Once you have pulled OpenRouter's model list, the cost shown for OpenRouter models uses its per-token prices (cache reads and writes, long-prompt tiers, reasoning tokens), labelled as an estimate with the download date. Provider setup shows the price and date next to each model.
- `continuous models refresh` (also `cn models refresh`) downloads the list explicitly and says which host it contacts and what it stores; `continuous models list [--json]` shows it. Neither contacts anything unless you run `refresh`.
- `--max-budget-usd` now works on OpenRouter models that are in the list, without `--budget-allow-unpriced`. A list older than 30 days gives a warning; one older than 90 days is not used for a budget.
