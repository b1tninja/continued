# Command analysis: shell dialects, substitutions and parser choice

Status: shipped in the PR that adds `substitutions.ts`, `detectShell.ts` and the shell-aware candidate
expansion. Research gathered 2026-11-10; links are to the pages read that day. Items marked "not
verified" came from a search snippet and not from the page itself.

## 1. The problem

The same character means different things per shell. A backtick is command substitution in bash, zsh
and sh, the escape character in PowerShell (`` `n ``, `` `$x ``, a line continuation) and nothing in
cmd. `$(...)` is substitution in POSIX shells and a subexpression in PowerShell (also `@(...)`, and
inside double quotes). `<(...)` is POSIX only. Single quotes suppress all of it in POSIX and
PowerShell, `\$(` is escaped in POSIX, `$((1+2))` is arithmetic. `extractSubstitutions` knew none of
this, and the candidate expansion took no shell, so a PowerShell backtick escape was read as a bash
substitution (a false deny) and, worse, a dialect-specific form could be read as safe under one grammar
while the real shell ran it.

## 2. Decision

Extend our own scanners; do not adopt a parser library for this step.

| Need | Choice | Why |
| ---- | ------ | --- |
| Which commands hide in the text | `substitutions.ts`: a per-grammar scanner (posix, zsh, powershell, cmd) with the union for an unknown shell | It must be fail-closed on what it does not understand and run in core, the extension host and the CLI with no native or WASM load. A full parser fails *open* on a parse error unless wrapped, and no parser covers PowerShell and POSIX at once. |
| Which dialect the text is | `detectShell.ts`: a weighted scorer over dialect-only syntax | Shebang rules do not apply to a one-line tool call; classifiers need training data we do not have; a scorer is explainable (it returns its evidence) and testable per case. |
| What to do when text and executor disagree | Read the text under every plausible grammar; union of candidates, most restrictive verdict (`grammarsToRead`, `classifyReadOnly`) | Removes the parser differential: a command is judged by every reading the shell could give it. |
| Tell the model | Lint codes CL040 to CL045 with the fix in the right dialect | The agent usually fixes it on the next turn. |

We already load `tree-sitter-bash` through `web-tree-sitter` in `treeSitterBash.ts` as a second reader
of POSIX commands. That stays: it cross-checks the strict scanner, and it is the one parser we
ship. It is not extended to PowerShell, see below.

## 3. Libraries, assessed

Packaging constraint: the code runs in core, which is bundled into the extension host and the CLI
binary; the webview does not analyse commands. Anything with a native add-on or a Go/.NET runtime is
out for the CLI binary unless it is a WASM file, and every WASM file is a load-time and size cost that
`treeSitterBash.ts` already pays once.

| Library | Dialects | License / maturity | Packaging | Substitution nodes | Verdict |
| ------- | -------- | ------------------ | --------- | ------------------ | ------- |
| tree-sitter-bash (in use) | bash; parses most POSIX/zsh text with ERROR nodes for the rest | MIT, widely used, Codex CLI also gates on it (see section 5) | WASM via `web-tree-sitter`, already bundled | yes (`command_substitution`, `process_substitution`, `arithmetic_expansion`) | Keep as the cross-check. Not used for zsh or PowerShell text. |
| [tree-sitter-powershell](https://github.com/PowerShell/tree-sitter-PowerShell) | PowerShell | MIT; the PowerShell-org repository is **archived since 2024-07-01** (read 2026-11-10); the README does not mention subexpressions or backtick escapes | WASM would be a second grammar load | not verified | Do not adopt: archived, unproven on `$()` and escapes, and a grammar that errors is a fail-open risk. |
| [mvdan/sh](https://github.com/mvdan/sh) via [sh-syntax](https://github.com/un-ts/sh-syntax) | bash, POSIX, mksh, bats (language variants) | MIT; sh-syntax is a WASM build with 116 commits, 71 stars (read 2026-11-10) | Go WASM, `main.wasm` (size not stated on the page; Go WASM is typically several MB, not verified) | the Go AST has `CmdSubst`, `ProcSubst`, `ArithmExp`; sh-syntax emits a JSON tree, node list not confirmed on its page | Best POSIX parser if we ever need one, but it adds a multi-MB runtime for a job the scanner does in microseconds. Revisit only if tree-sitter-bash gaps outgrow the cross-check. |
| bash-parser, unbash style JS parsers | bash/POSIX subset | small or unmaintained packages (not verified) | pure JS | yes | Not adopted: no zsh or PowerShell, and a subset parser that throws is a fail-open path. |
| shell-quote | splits and quotes POSIX-like words | MIT, mature | pure JS, already a dependency of `packages/terminal-security` | no (it returns tokens, and `$(...)` appears as text or an op) | Already used there. Not a substitution reader. |
| bashlex (Python) | bash | GPL-3.0 (not verified) | Python | yes | Not usable: wrong runtime and license. |
| PowerShell `[Parser]::ParseInput` | PowerShell, the real AST | part of PowerShell (MIT) | needs a `powershell.exe` or `pwsh` process; no in-process option from Node | yes (`SubExpressionAst`, `ArrayExpressionAst`, `ExpandableStringExpressionAst`) | The only authoritative PowerShell reader, but a process start is 170 ms for `powershell.exe -NoProfile -NonInteractive -Command exit` per a [Claude Code issue](https://claudeissues.com/issue/101009-bug-powershell-tool-starts-powershell-twice-per-call-parse-then-run-0-6-s-and-0) and about 450 ms warm for `pwsh` per a comment in a Claude Code `parser.ts` mirror (secondary sources; I could not find a figure for `ParseInput` itself). That issue also notes it doubled the cost of a call. Viable as an opt-in second reader for Windows with a long-lived helper process, not as the default gate. Future work. |
| ShellCheck | sh, bash, dash, ksh | GPL-3.0, Haskell binary | external binary | internal | Not embeddable. We borrow its dialect-detection order (section 4). |
| Python `shlex`, Rust `shell-words`/`shlex` | POSIX word splitting | PSF / MIT | other runtimes | no | Irrelevant to a TypeScript core. |

## 4. Dialect detection: prior art and what we took

- ShellCheck decides in this order: a `# shellcheck shell=` directive, then the shebang, then the file
  extension (`.bash`, `.bats`, `.dash`, `.ksh`) ([manual](https://man.archlinux.org/man/shellcheck.1.en)).
  An unrecognised shebang is an error that asks for the directive.
- `shfmt -ln auto` reads the filename extension, then a shell shebang, and falls back to bash
  ([man page](https://man.archlinux.org/man/shfmt.1.en)).
- Editors and linguist-style tools add file extension and content heuristics over a file; none handles
  a one-line command with no shebang.

Their signals are file metadata. A tool call has none, so the only signal is the text. `detectShell.ts`
keeps the shebang rule (if the text starts with one) and otherwise scores syntax that only one dialect
has: `$env:X`, Verb-Noun cmdlets, `@{}`, `[type]::` and `-eq` outside `[ ]` for PowerShell;
`export X=`, `; then`, `/dev/null`, `<<EOF`, `${v:-x}` for POSIX; `[[ ]]`, `<<<`, arrays and `{a,b}`
for bash and zsh over sh; `setopt`, `${(f)...}`, `*(.)`, `=cmd` for zsh; `%VAR%`, `if exist`, `/b`
switches and `set X=` for cmd. It returns `likely`, `evidence` and a three-level `confidence`, and it
never overrides the executor: it only widens what analysis reads and triggers lint.

## 5. Parser differentials in agent command gating

What the public record says went wrong in other agents, and the class each belongs to. Every class has
a regression test in `bypassClasses.vitest.ts`.

| Product | Reference | Class | Our test |
| ------- | --------- | ----- | -------- |
| Cursor < 1.3 | [CVE-2025-54131](https://nvd.nist.gov/vuln/detail/CVE-2025-54131): allowlist bypassed in auto-run with a backtick or `$` substitution | command substitution | "command substitution", "backtick substitution", "substitution in double quotes" |
| Cursor | CVE-2025-62354 ([HiddenLayer](https://hiddenlayer.com/sai_security_advisor/2025-11-cursor/)): allowlist bypassed with brace expansion in zsh or bash; fixed in 2.0 | brace expansion | "brace expansion" (bash and zsh) |
| Cursor | [CVE-2026-22708](https://dev.to/cverports/cve-2026-22708-trust-issues-bypassing-cursor-ais-safe-mode-via-shell-built-ins-55ao): shell built-ins `export` and `alias` poison the environment of an allowed command | environment and builtin state | "environment prefix and export" |
| Gemini CLI | Tracebit report, via [CSO Online](https://csoonline.com/article/4030700/google-patches-gemini-cli-tool-after-prompt-injection-flaw-uncovered.html): allowlisting could not tell `grep` from a command that starts like it, and blank padding hid the rest of a line | prefix matching, whitespace padding | "blank padding", and the matcher compares whole candidates, not prefixes of the text |
| Gemini CLI | [GHSA-wpqr-6v78-jr5g, CVSS 10.0](https://thehackernews.com/2026/04/google-fixes-cvss-10-gemini-cli-ci-rce.html): the policy engine skipped the allowlist in `--yolo` mode, fixed in 0.39.1 | policy not applied in one mode | Out of scope here: our floor and protected paths already bind at YOLO |
| Claude Code | [CVE-2025-55284](https://www.kodemsecurity.com/cve-archive/cve-2025-55284) (before 1.0.4): too-broad allowlist of "safe" commands let a read and an upload through; CVE-2025-58764 (`rg`, before 1.0.105), CVE-2025-54795 (`echo`) and CVE-2026-24887 (`find`), all described as command-parsing errors that skipped the prompt (from a CVE index; advisories not opened) | flags of allowlisted commands | Covered by `commandSpecs.ts` and the read-only classifier, not by this change |
| Codex CLI | Exec policy: scripts with redirects, substitutions or control flow fall back to matching the whole `bash -lc` wrapper (secondary blog, [Codex exec policy](https://codex.danielvaughan.com/2026/05/21/codex-cli-execution-policy-rules-starlark-command-governance-enterprise-allowlists/)); a tree-sitter-bash allowlist of node kinds rejects any node it does not know, and a missing kind (`concatenation`) once broke parsing (a mirror of commit #8395, not the upstream repository); CVE-2025-54558 auto-approved `rg --pre` | unknown node means "not understood", not "safe" | Our scanner and the tree-sitter gate already do the same. The new code adds "dynamic" results that fail closed. |
| Cline | One hit, CVE-2026-30312 on a fork named DSAI-Cline (vulners tag page); no upstream write-up found | n/a | n/a |
| Cross-product | A 2026 blog argues text filters lose to expansion and that the sandbox is the boundary ([guardfall](https://codex.danielvaughan.com/2026/07/15/guardfall-shell-injection-bypass-open-source-coding-agents-codex-cli-kernel-sandbox-defence/), secondary) and Cursor's own response was that its allowlist is best-effort | text gating is defence in depth | Agrees with `plans/isolation.md`: this analysis lowers risk, the container is the boundary. |

Classes with no public case but real in our shells, tested anyway: heredoc bodies, process
substitution, arithmetic with a nested substitution, `$IFS`, ANSI-C quoting, a shell inside a shell, a
shell inside PowerShell, PowerShell backtick-escaped names, `Invoke-Expression`, cmd `for /f`, zsh `=cmd` and
glob qualifiers, and PowerShell curly quotes (PowerShell reads U+2018 to U+201B and U+201C to U+201E as
quote characters; a bash reading of the same text sees ordinary characters).

## 6. What shipped

- `substitutions.ts`: `scanSubstitutions(text, shell?)` and `extractSubstitutions(text, shell?)`.
  Quote, escape, comment, heredoc and arithmetic aware; zsh `=(...)`, `*(e:...:)`; PowerShell
  `$(...)`, `@(...)`, here-strings, `<# #>`, curly quotes; cmd `for /f ... in ('...')`. Anything it
  cannot read (`${(e)x}`) is reported as `dynamic`, and the candidate expansion then sets
  `truncated`, which makes every deny and ask rule hit (fail closed). With no shell it returns the
  union of all grammars, which is the old behaviour minus quoted and escaped forms.
- `candidates.ts`: `commandCandidateSet(command, shell?)` reads the shell's own grammar plus every
  other grammar the text plausibly belongs to (`grammarsToRead`); a script handed to a named shell
  (`bash -c`, `pwsh -Command`, `cmd /c`, `iex`) is read in that shell's grammar.
- `detectShell.ts`: `detectCommandShell`, `mismatchedShell`.
- `readOnlyCommand.ts`: a command is vouched read-only only if every plausible reading is.
- `commandLint.ts`: CL040 (`&&` in PowerShell), CL041 (`2>/dev/null`), CL042 (bash text on
  PowerShell, with the PowerShell equivalent), CL043 (cmd text on PowerShell), CL044 (PowerShell
  text on bash or zsh), CL045 (text for another shell on cmd).
- `rules.ts`, `protectedCall.ts`, `decide.ts`, `evaluate.ts`: the executor's shell is passed down.

## 7. Not done, and why

- A PowerShell AST reader (`ParseInput`) behind a long-lived helper process: cost and Windows-only; a
  candidate for a later step if the scanner's gaps show up in the corpus.
- Replacing the scanners with mvdan/sh WASM: size and a second runtime for little gain.
- zsh `${(e)x}` and function-calling glob qualifiers are not resolved, only flagged.
- Detection is text-only and weighted by hand; the table in `detectShell.vitest.ts` is the place to
  add a case when it is wrong.
