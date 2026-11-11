# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## Privacy

- The 2.12.0 and 2.12.1 builds contained two things that contradicted "collects no telemetry": the `search_web` tool and the docs crawler's `useLocalCrawling: false` path sent queries and URLs, with the extension version, the operating system, a machine id and a key embedded in the code, to a proxy run by the upstream Continue project; and the terminal agent's system prompt told the model to add a `Co-Authored-By: Continue` trailer to commits. The terminal agent's OpenTelemetry metrics also started whenever any `OTEL_*` variable was set. The commit trailer is fixed in [#626](https://github.com/b1tninja/continuous/pull/626) (merged); the proxy calls and the metrics default are changed in [#627](https://github.com/b1tninja/continuous/pull/627) (not yet merged when this was written: keep this sentence only if it is in the release).
- What Continuous stores, sends and does not send is now written down in [PRIVACY.md](https://github.com/b1tninja/continuous/blob/main/PRIVACY.md).
