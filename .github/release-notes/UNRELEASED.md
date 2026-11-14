# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

- **IDGAF no longer denies or asks about anything, including rules you set as Never.** At IDGAF the permission layer lets every tool call through: Never (`deny`) and always-on (`floor`) rules, the CLI's `exclude` lists and `--exclude`, protected paths and secret files, the safety floor, commands that hide what they run, writes to paths built at run time, the locked policy and configuration files, the tainted-session rule and changed MCP tool definitions no longer stop a call, and nothing waits for an answer. In `cn -p` and `cn serve`, tools that ask or are excluded are offered at IDGAF, and a loop worker of an `--auto` parent runs at the parent's levels. What would have stopped each call is recorded in its decision and in the audit trail, never shown to the model. A tool you switched off, Plan mode, an `--agent` file's tool list, a subagent's limits and hooks you wrote yourself still apply. Below IDGAF nothing changed.

## Fixes
