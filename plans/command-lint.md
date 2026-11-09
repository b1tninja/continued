# Command lint

Status: R0 built, 2026-11-09 (`core/tools/permissions/commandLint.ts`, wired into the IDE and CLI terminal tools); R1 to R6 not started. Roadmap row: Track R. Builds on [`command-analysis.md`](./command-analysis.md) (Track P), which decides what a command _does_; this decides whether it is _written correctly_.

## Why

An agent often edits files by running a command: `cat > file <<EOF`, `echo "..." > file`, `python -c "..."`. In that route the text goes through the shell's quoting before the file sees it. Quotes, backslashes, `$` and backticks arrive changed, a heredoc body that contains its own delimiter ends early, and nothing says so: the command exits 0 with the wrong file, or the shell reports a syntax error only after the call has run. The agent learns why from the error, one round trip late, and sometimes not at all.

Other agent hosts report the same family of failure: a Claude Code user describes the model suddenly choosing `cat` with a heredoc and the EOF marker being mangled; a Zed commit fixed heredocs failing in its agent shell; a VS Code Copilot instruction file tells the model to avoid terminal heredocs because of quote and backtick escaping; a Claude Code issue reports a single-quoted heredoc with single quotes inside failing with `unexpected EOF`. (Reports read 2026-11-09 through search snippets; the Claude Code issue page and the Zed commit page could not be fetched, so none was read in full.)

On Windows the IDE runs `powershell.exe`, so a bash heredoc is not merely garbled, it is not valid at all.

## What exists elsewhere

- **ShellCheck** is the reference: a static analyser for sh and bash that works on the script text. Relevant checks (read from its wiki): SC1039, a heredoc end token must not be indented; SC2016, expressions do not expand in single quotes; SC2086, unquoted expansions split; SC2028, `echo` does not expand `\n`. It needs the `shellcheck` binary, handles POSIX shells only, and is written for scripts, not for one-line commands an agent sends. It is the model for the finding format (a code, a message, a fix) but not something to require.
- **PSScriptAnalyzer** analyses PowerShell. No rule specific to here-string quoting or backtick escapes was found (the search surfaced a note that backticks hurt readability, and a newer rule about double quotes around constant strings). Microsoft's [about_quoting_rules](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_quoting_rules) is the source for the PowerShell pitfalls: the backtick is the escape character, and here-strings take quotes literally.
- **The bash grammar** (tree-sitter-bash) is already loaded by core (`treeSitterBash.ts`) and reports error nodes and missing tokens with positions. That gives the syntax-error rule for free; the CLI does not load it yet (R3).
- **Agent hosts** deal with this by prompt advice (a CLAUDE.md line, an instruction file) or by fixing the shell wrapper. None found checks the command before it runs. The gap is the opportunity.

## Design

A pure function, `lintCommand(command, shell)`, returns findings: a stable code, a severity, one sentence on what is wrong, one on what to do instead, and a line when known. It never throws and reads only the text and the shell kind (`resolveShell().kind`, the same identity the classifiers use).

Two severities, and what the gate does with each (`commandLintGate`):

| Severity | Means                                                                                                                          | What happens                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `error`  | The command cannot do what it says: a syntax error, a heredoc that never ends, bash syntax on PowerShell                       | The call does not run. The agent gets the finding and fixes the command                                                                 |
| `warn`   | A pattern that is usually a mistake: a file written through a heredoc, an unquoted delimiter that expands, `echo` with escapes | The call does not run the first time. The same command sent again runs as written. That is the confirmation, with no new tool or prompt |

The gate is a tool-result message ("The command was not run: ..."), not a permission prompt, so it works headless and in a loop, costs one round trip only when there is something to say, and leaves the policy engine alone. Off with `CONTINUE_COMMAND_LINT=off`.

### Rules in R0

| Code  | Severity | What it finds                                                                                                    |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| CL000 | error    | The bash grammar reports a syntax error (message with line and column; only where the grammar is loaded)         |
| CL001 | error    | A bash heredoc (`<<EOF`) in PowerShell                                                                           |
| CL002 | error    | `export NAME=value` in PowerShell                                                                                |
| CL003 | error    | `NAME=value command` in PowerShell                                                                               |
| CL004 | warn     | `$env:NAME` or a `Get-` cmdlet in a POSIX shell                                                                  |
| CL010 | warn     | A heredoc (or `tee`) that writes a file: use the edit tool                                                       |
| CL011 | warn     | `echo` or `printf` writing a file with backslash escapes in the text                                             |
| CL012 | warn     | `echo "...\n..."` without `-e` (SC2028)                                                                          |
| CL020 | error    | A heredoc with no closing line                                                                                   |
| CL021 | error    | A closing line that is indented or padded, so it is read as content (SC1039)                                     |
| CL022 | warn     | An unquoted delimiter with `$`, a backtick or a backslash in the body: the shell expands it                      |
| CL030 | warn     | A long `python -c`, `node -e`, `perl -e` or `pwsh -Command` script in double quotes with `$`, a backtick or `\"` |

What is deliberately not flagged: a heredoc that only feeds a command (`python - <<'PY'`), a here-string `<<<`, `<<` inside a quoted string, an unquoted delimiter over a plain body.

### Limits

- The heredoc reader is line-based, not a parser. A `<<` that is really arithmetic or in a quoted multi-line string can be misread; `insideQuotes` covers a single line only. False positives matter more than misses here, because a wrong stop costs a round trip, so R1 measures them before any rule is made an error.
- The delimiter-in-body case (a file whose content contains a line equal to the delimiter) cannot be seen when the heredoc ends early at that line: the command parses, and the rest of the text becomes commands. The bash grammar's error nodes catch the usual result (CL000) only when the leftover text is not valid shell.
- A warning stops a command once per distinct text per process. A model that changes one character gets stopped again; that is correct, because the text changed.

## Build order

| #   | Scope                                                                                                                                                                                                         | Done when                                                                                      | State       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| R0  | The rules above, the gate, wired into core's and the CLI's terminal tools                                                                                                                                     | `commandLint.vitest.ts` passes: each rule fires on its case and stays quiet on the near misses | Built       |
| R1  | Measure on real runs and in the bench: fire rate per code, how often the agent changes the command after a warning, false positives. Add a bench scenario that writes a file with quotes, `$` and backslashes | A table per code; a rule with false positives over 5% is demoted or fixed                      | Not started |
| R2  | A setting per code (`off`, `warn`, `error`), a Settings row, and the lint message shown on the tool call in chat                                                                                              | A person can turn one rule off without losing the rest                                         | Not started |
| R3  | The CLI loads the bash grammar                                                                                                                                                                                | CL000 fires in the CLI with a position                                                         | Not started |
| R4  | PowerShell: ask PowerShell's own parser for syntax errors when one is available, and add here-string and backtick rules                                                                                       | A PowerShell syntax error is reported with a position before the call                          | Not started |
| R5  | ShellCheck-class rules on the command graph (SC2086, SC2164, SC2115, SC2035) as warnings, and the `shellcheck` binary when installed (`--format=json`), never required                                        | `rm -rf $DIR/` with an unquoted or empty variable is flagged                                   | Not started |
| R6  | Steer, not only stop: when a write through the shell is found, the message includes the equivalent edit-tool call filled in from the heredoc (path and content)                                               | The agent can confirm the edit-tool call with one call                                         | Not started |

## Decisions for the owner

| #   | Decision                                          | Options and a recommendation                                                                                                                                       |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Should a heredoc file write be `warn` or `error`? | `warn` (recommended) until R1 shows how often the heredoc is right. Some uses are legitimate (a quoted heredoc to a temp file, a config written by a setup script) |
| D2  | A message or a permission prompt                  | A tool-result message (recommended): it works headless and in loops. A prompt would interrupt the person for a mistake the agent can fix itself                    |
| D3  | Require `shellcheck`                              | No. Use it when present (R5); the built-in rules must stand alone                                                                                                  |

## Out of scope

- Whether a command is safe to run. That is the policy engine and command analysis (Track P).
- Running a command to test it, dry runs or a sandbox.
- Linting scripts the agent writes to files; this reads the command line it is about to run.
