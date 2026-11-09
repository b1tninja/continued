# Command analysis

Status: plan, 2026-11-09. Nothing in the build order is started except the first read-only classifier (see "What exists"). Roadmap row: Track I. Builds on [`policy-areas.md`](./policy-areas.md) ("Which area a call belongs to", "Built-in rules") and replaces the ad hoc scanners that section grew.

## Why

The policy work decides what runs without asking. Most of that decision is about a terminal command, and today it is made by reading the command as text:

- Is this command only reading? (Context use, plan turns, Permissive.)
- Does it write, and where? (File edits rules, protected paths, plan mode.)
- Does it run something else, or reach the network?
- Does a rule written as `runTerminalCommand(git push*)` cover it?

Text matching answers those well for `git status` and badly for everything else. The way out is to read a command the way the shell does: split it into pipelines and commands, tell the program from its path, its subcommand and its flags from its operands, know what each flag and subcommand does, and say one of three things: **it only reads**, **it writes** (we are sure), or **we do not know**. Rules, areas and the reviewer then work on that answer, not on a string.

### The mismatch that comes first

Every scanner in the repository reads POSIX shell syntax. The shell that runs the command is not always one:

| Where                  | Shell that runs the command                                | Source                                                               |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| IDE on Windows         | `powershell.exe -NoLogo -ExecutionPolicy Bypass -Command`  | `core/tools/implementations/runTerminalCommand.ts` `getShellCommand` |
| IDE on macOS and Linux | `$SHELL -l -c` (zsh on a Mac by default, so a login shell) | same                                                                 |
| CLI                    | `$SHELL` or `/bin/bash`, with a WSL path                   | `extensions/cli/src/tools/runTerminalCommand.ts`                     |

A classifier that is certain of a command's meaning in bash can be wrong about the same characters in PowerShell or cmd: `date 1-1-20` is a harmless read in bash and sets the clock in cmd, `find` and `sort` are different programs on Windows, and in PowerShell a backtick is an escape, `sort` is `Sort-Object`, and flags may be abbreviated. A verdict is only as good as the grammar used to reach it, so **the first rule of this plan is: classify with the grammar of the shell that will run the command, and treat an unknown shell as unknown.**

## What exists (read from the code, 2026-11-09)

| Piece                                                           | What it does                                                                                                                                                                                                                                                        | Reads                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `core/tools/permissions/command.ts` `parseCommand`              | Splits on unquoted `&& \|\| ; \| &` and newlines; flags file redirects and unparsable quoting. Allow rules apply only to a command it fully understands                                                                                                             | POSIX                                 |
| `shellWords.ts`, `candidates.ts`                                | Quote removal, directory and `.exe` stripping, `git -C x -c y push` read as `git push`, wrappers (`sudo`, `env`, `timeout`), nested `bash -c`, `powershell -Command`, `python -c`, `eval`, `xargs`, pipes into a shell. Only adds candidates for deny and ask rules | POSIX, with PowerShell wrappers       |
| `packages/terminal-security` `evaluateTerminalCommandSecurity`  | `shell-quote` tokenization, a refusal list and a safe list: the "safety floor"                                                                                                                                                                                      | POSIX                                 |
| `protectedCall.ts`, `secretCommands.ts`                         | Scans the words of a command for protected paths, credential variables and UNC paths                                                                                                                                                                                | text                                  |
| `readOnlyCommand.ts` (first classifier, shipped on this branch) | Strict tokenizer, a read-only list with argument checks, git vouched after a config scan; used for Context use and plan turns                                                                                                                                       | POSIX; names also used for PowerShell |
| `corpus/denyVariants.ts`                                        | A corpus of ways to spell a denied command                                                                                                                                                                                                                          | POSIX and PowerShell spellings        |
| `tree-sitter-wasms` (a dependency of `core`)                    | Ships `tree-sitter-bash.wasm`. Not used for commands today. It has no PowerShell or cmd grammar                                                                                                                                                                     | bash                                  |

Five readers of the same string, no shared structure, no knowledge of which shell runs it. They already disagree about what a command is (a differential run is I0).

## Known gaps in the first classifier

The read-only classifier is conservative, but it was built before this plan and shares the mismatch. Listed so none is forgotten:

| Gap                                                                                                                                                                                                                                                                                    | Severity         | Fixed by                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| One list of names for every shell. `date`, `find`, `sort`, `hostname`, `echo`, `type` and `tree` mean different things in cmd and PowerShell                                                                                                                                           | high on Windows  | I1 (done on this branch: a list per shell; cmd and unknown shells are never vouched) |
| Tokenizes PowerShell with POSIX rules. It rejects `$`, backticks, braces and `(` outright, which is safe, but it does not know aliases (`sort`, `diff`, `curl`, `wget`) or parameter abbreviation (`-Rec`) and colon form (`-Path:x`), which defeat flag reject lists                  | medium           | I3                                                                                   |
| cmd searches the current directory first, so any command name can be a file in the repository (`dir.bat`); no list can cover that                                                                                                                                                      | high on cmd      | I4 (treat cmd as unsure by default)                                                  |
| Flags are matched as written. `--out=x` and `--ou x` spellings that a program accepts as abbreviations are not all covered                                                                                                                                                             | medium           | I5 (specs say which abbreviations a program takes)                                   |
| Paths are not extracted, so a vouched `cat` of a protected file is caught only by the text scan in `protectedCall.ts`                                                                                                                                                                  | medium           | I6                                                                                   |
| Globs are accepted in read-only commands; a file named like a flag can be matched by `*`                                                                                                                                                                                               | low              | I5                                                                                   |
| zsh features (`=cmd`, glob qualifiers such as `*(e:...:)`, `setopt` in `.zshenv`) are rejected by character, not understood                                                                                                                                                            | safe, not useful | I2                                                                                   |
| Fixed on this branch: a backslash in a POSIX shell is an escape and the scanner read it as a letter, so an escaped quote could hide a second command (bash ran the `rm`, the scanner saw one `echo`); it is now not understood in bash, zsh and sh. Also zsh `=cmd` and PowerShell `@` | done             | I1                                                                                   |
| Fixed on this branch: git was vouched from a subfolder, in a worktree, and after a `cd`; it is now refused in each                                                                                                                                                                     | done             | -                                                                                    |

## Measured by I0

`core/tools/permissions/corpus/verdicts.ts` holds about 250 commands, each with the shell it is read in and what is true of it (reads, writes or unsure), and `plans/command-analysis-report.md` is generated from it and checked by the build. Read it for the numbers; what it found on the first run:

- **No scanner vouches for a command that is not read-only**, in any shell. That is a test, not a measurement.
- **The classifier vouches for 83 to 92 percent of the plain reads** in bash, zsh, sh and PowerShell, and for none in cmd, by design. The reads it declines are `{a,b}`, `$HOME`, `$((1+2))`, `<(...)`, escaped spaces, `Where-Object { }` and zsh glob qualifiers: the work list for I2 and I3.
- **The protected-path scan agrees with the corpus** in every shell, including `%USERPROFILE%` and `$env:USERPROFILE`.
- **A text rule on `Remove-Item` does not see PowerShell's `rm`, `del` or `ri`.** The one disagreement found, and the reason I3 resolves aliases. It is kept in a known-gaps list so that fixing it flips a test.

## Design

### Three verdicts, and what lies under them

Every command, and every part of one, gets:

| Verdict    | Means                                                                      | Used for                                                                   |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **reads**  | We are sure it only reads                                                  | Context use; runs in plan turns; Permissive and Cautious allow rules apply |
| **writes** | We are sure it changes something, and know what when the path is a literal | File edits rules by path; refused in a plan turn instead of asked; Manual  |
| **unsure** | Anything we did not fully understand, in either direction                  | Tool use; asks; the reviewer at Automatic                                  |

Under them is a set of **effects** per command: `read(paths)`, `write(paths)`, `delete(paths)`, `exec(program)`, `network(host)`, `env`, `credentials`, `service`. `reads` means the effects are only `read`; `writes` means at least one known `write`, `delete` or `exec` of a known writer; anything with an effect we cannot name makes the whole command **unsure**. The effect set is what lets a rule say `effect: network` without naming every program.

"Sure it writes" matters as much as "sure it reads". It is what lets a plan turn refuse `rm` with an explanation instead of asking, lets File edits rules see `echo x > .github/workflows/ci.yml`, and lets the person read "this will change files" on the prompt.

### Layers

1. **Shell identity.** One `resolveShell()` shared by core and the CLI returns the kind (`bash`, `zsh`, `sh`, `powershell-5`, `powershell-7`, `cmd`, `unknown`), the executable, how it is started, and whether start-up files run (a login shell, or a PowerShell without `-NoProfile`, runs the person's own code first). It travels with every evaluation. A classifier asked about a shell it does not know says unsure.
2. **Front end per shell family**, one shared output. Each parser produces the same graph: a script is lists (`&&`, `||`, `;`, `&`, newline) of pipelines (`|`, and PowerShell's object pipeline) of commands. A command has a program (as written and resolved), words, redirects, assignments and wrappers. Each word records whether it is a literal, quoted text, a glob or an expansion. Every node has `understood: true | false` with the reason, so "we did not parse this" is a fact in the graph and not a missing entry.
3. **Resolution.** Program name normalized for the shell (case on Windows, `.exe`, directories, PowerShell aliases to cmdlets, `cmd` builtins), then wrappers peeled (`sudo`, `env`, `timeout`, `nohup`, `time`, `command`, `exec`, `xargs`, `find -exec`, `ssh host cmd`, `bash -c`, `powershell -Command`, `cmd /c`, `wsl -e`, `npx`, `uv run`). Analysis recurses into the wrapped command to a fixed depth. A wrapper we do not know makes the command unsure.
4. **Command specs.** One declarative spec per program, per shell where the program differs: its global flags, its subcommands, what each flag and subcommand does, which operands are paths, patterns or URLs, and which flag spellings the program accepts. A spec turns a resolved command into effects. No spec means unsure.
5. **Policy.** Areas, rules, protected paths, plan mode and the reviewer consume the verdict and effects (see "Policy integration").

### What each shell makes hard

| Shell                        | Hazards the front end has to know about                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bash, sh, dash               | `$()`, backticks, `${}`, process substitution `<()`, heredocs, brace expansion, globs, `eval`, functions, `$'...'`, `BASH_ENV` (a file run by a non-interactive shell). A login shell runs `~/.bash_profile` first                                                                                                                                       |
| zsh (macOS default)          | All of the above, plus `=cmd` expansion, glob qualifiers that run code (`*(e:...:)`), `**` recursion, `~` named directories, options set in `.zshenv` (always read, even for `-c`), `$(<file)`. `-l` reads `.zprofile`                                                                                                                                   |
| PowerShell 5.1 and 7+        | Backtick escape; `$()`, `@()`, `@{}`; `&` call and `.` dot-source; aliases that shadow GNU names (`ls`, `cat`, `rm`, `sort`, `diff`, `echo`, `curl`, `wget`); parameter abbreviation (`-Rec`) and colon form (`-Path:x`); `Invoke-Expression`/`iex`, `-EncodedCommand`, `Start-Process`, `Invoke-Command`; `>` writes a file (UTF-16 in 5.1); `&&` and ` |     | `only in 7+; the profile runs because the start-up does not pass`-NoProfile` |
| cmd and batch                | `%VAR%` is expanded before parsing, so the text is not the command; `^` escapes; `&`, `&&`, `\|\|`; `call`, `for /f`, `if`; the current directory is searched first for programs; `date` and `time` set the clock when given a value; `.bat` files are scripts we cannot read ahead; `!VAR!` with delayed expansion                                      |
| WSL, Git Bash on Windows     | A second shell nested in the first (`wsl -e`, `bash.exe -c`). Paths cross a boundary (`/mnt/c`). The CLI already special-cases WSL; the analysis must follow it                                                                                                                                                                                          |
| fish and others via `$SHELL` | Not parsed. Unsure, until someone adds a front end                                                                                                                                                                                                                                                                                                       |

The cmd front end is deliberately weak: any `%`, `!`, `^`, `call`, `for`, `if` or program name that could be a file in the working directory is unsure. Reading a cmd line is worth doing only far enough to recognise a plain `dir` or `type`.

### Command specs

A spec is data checked by tests, not code scattered over the classifiers. Sketch, for git:

```ts
git: {
  // flags before the subcommand: the first two run programs or move the repository
  global: {
    safe: ["--no-pager", "--no-optional-locks", "-P"],
    runs: ["-c", "-C", "--exec-path", "--git-dir", "--work-tree"],
  },
  guard: "gitConfigRunsNothing",              // a check on the repository, not on the words
  sub: {
    status:   { effects: [read("cwd")] },
    log:      { effects: [read("repo")], flags: { "--output": write("value") } },
    diff:     { effects: [read("repo")], flags: { "--output": write("value"), "--ext-diff": exec("config") } },
    branch:   { by: "operands" },             // none or a list flag: read; a name: writes
    checkout: { effects: [write("worktree")], flags: { "--": operands("path") } },
    push:     { effects: [network("remote"), write("remote")] },
  },
  otherSub: "unsure",
}
```

Specs carry the facts that today live in the code of `readOnlyCommand.ts` (find without `-exec`, sort without `-o`) and in `candidates.ts` (git global flags with arguments), once, so the classifier, the rule matcher and the protected-path check read the same table. A spec linter fails a build on a flag that appears in two effect lists, a subcommand with no effect, or a spelling that is a prefix of another.

### Policy integration

- **Areas** are chosen by effects: all `read` is Context use; any `write` with a literal path is checked against the File edits rules and protected paths; `exec` and `network` are Tool use. This replaces the name list in `areaOfTool` for terminal commands.
- **Rules** keep their text form (`runTerminalCommand(git push*)`) and gain forms that match the resolved command: `git push`, `git push --force*`, `effect:network`, `effect:delete`. A rule is matched against the resolved program and subcommand, so `/usr/bin/git`, `git.exe` and `git -C x push` are one thing. Allow rules still apply only to a fully understood command.
- **Paths** come from the graph (operands the spec marks as paths, redirect targets, `tee`, `sed -i`), replacing the word scan in `protectedCall.ts`. A literal path is checked exactly; a path built from an expansion makes the command unsure.
- **Plan mode** refuses a `writes` command with its reason and runs a `reads` command; `unsure` asks.
- **The decision chip and the reviewer** receive the claim: who judged (the parser, which front end), the verdict, the effects and, for unsure, the first thing not understood.

## Build order

| #   | Scope                                                                                                                                                                                                                                                                                                                                           | Depends on | Done when                                                                                                                                             | State        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| I0  | **Built on `claude/policy-wiring`.** One corpus of (shell, command, expected verdict, expected effects and paths), built on `corpus/denyVariants.ts`, and a differential run of every current scanner over it. A report of where they disagree                                                                                                  | none       | At least 50 cases for each of bash and zsh, PowerShell and cmd; the disagreement report is in the repository; CI runs the corpus on Windows and Linux | Built, no PR |
| I1  | **Built on `claude/policy-wiring`.** Shell identity (`resolveShell()`), carried with every evaluation, protocol and CLI. The first classifier takes the shell: its list is per shell, cmd is unsure, an unknown shell is unsure. Fixes the high-severity rows in "Known gaps"                                                                   | none       | `date`, `find`, `sort`, `hostname`, `echo`, `type` are right on each shell in tests; a command evaluated for cmd or an unknown shell is never vouched | Built, no PR |
| I2  | A POSIX front end and the shared graph. Replaces `parseCommand`, the tokenizer in `readOnlyCommand.ts` and the splitting in `candidates.ts`. The old scanners stay as oracles until I0 shows no disagreement                                                                                                                                    | I0, D1     | Allow rules, deny and ask candidates, the safety floor and the read-only classifier read the graph; the differential run is clean                     | Not started  |
| I3  | A PowerShell front end for the same graph: aliases, parameter abbreviation and colon form, `iex` and `-EncodedCommand` as `exec`, a strict subset otherwise                                                                                                                                                                                     | I2, D2     | The PowerShell cases of the corpus pass; a Windows CI job compares the subset's tokens with PowerShell's own parser                                   | Not started  |
| I4  | A cmd and batch front end, conservative: only plain programs with literal arguments are understood                                                                                                                                                                                                                                              | I2, D3     | Every cmd case with `%`, `!`, `^`, `call`, `for` or `if` is unsure; a plain `dir` and `type` are reads                                                | Not started  |
| I5  | Command specs and the effect set, a table-driven test per spec and the linter. First specs: `git`, `npm`, `pnpm`, `yarn`, `pip`, `uv`, `cargo`, `go`, `docker` (read subcommands), `kubectl` (get, describe), `gh` (as network), `curl`, `rm`, `mv`, `cp`, `mkdir`, `touch`, `tee`, `dd`, `find`, `sed`, `sort`, and the PowerShell equivalents | I2, I3     | `readOnlyCommand.ts` is generated from the specs and no test changes; each spec lists the flag spellings its program accepts                          | Not started  |
| I6  | Policy: areas by effects, rules on resolved commands (`git push`, `effect:network`), paths from the graph for the protected-path and File edits checks, plan mode refusing known writes, the claim on the chip and to the reviewer                                                                                                              | I5         | The text scan in `protectedCall.ts` is gone; `echo x > .github/workflows/ci.yml` is a File edits question; a rule `effect:delete` works               | Not started  |
| I7  | Wrappers and nesting: the wrapper list above, recursion to a fixed depth, and an unknown wrapper is unsure                                                                                                                                                                                                                                      | I5         | `sudo`, `env`, `timeout`, `xargs`, `find -exec`, `ssh host cmd`, `bash -c`, `powershell -Command`, `cmd /c` and `wsl -e` are analysed through         | Not started  |
| I8  | User specs and a per-project list of known commands: a `commandSpecs:` block and a list such as `npm test`, in user settings only, keyed to the hash of the file that defines the script. A workspace file cannot add to either                                                                                                                 | I5, I6     | A user spec changes a verdict; a repository's own file does not                                                                                       | Not started  |
| I9  | Local data on which asks the person approved, kept on the machine, to rank the specs most worth writing                                                                                                                                                                                                                                         | I6         | A report of the commands the person approved most, by program and subcommand                                                                          | Not started  |

I0 and I1 can start at once. I1 is a patch of the shipped classifier and should not wait for the parsers.

## Decisions for the owner

| #   | Decision                                                             | Options and a recommendation                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The POSIX parser                                                     | tree-sitter-bash (the wasm is already a dependency; real structure and error nodes; it is a bash grammar, so zsh-only syntax appears as errors, which is what we want) or a hand-written strict scanner (small and understood, a second thing to keep right). **Recommend tree-sitter-bash**, with our own gate on top: an error node, or any construct outside a short list, makes the node not understood |
| D2  | The PowerShell parser                                                | Our own scanner for a strict subset, or PowerShell's own `Parser.ParseInput`, which is exact but needs a PowerShell process per command. **Recommend our own subset at run time**, and PowerShell's parser as the oracle in Windows CI only                                                                                                                                                                 |
| D3  | How far to go on cmd                                                 | Conservative only (recommended), or a fuller batch grammar. A full one cannot be sound because `%VAR%` expands before parsing                                                                                                                                                                                                                                                                               |
| D4  | Where specs live                                                     | Typed TypeScript modules in the repository (recommended, so the linter and types apply), with a YAML form accepted only from user settings (I8)                                                                                                                                                                                                                                                             |
| D5  | Shells beyond bash, zsh, PowerShell and cmd                          | fish and nushell are unsure until someone writes a front end. Say so in the UI                                                                                                                                                                                                                                                                                                                              |
| D6  | Whether a known write by a command goes through the File edits rules | Yes for a literal path (recommended): `echo x > file` is a File edits question, with the "commands can still write files" note kept for what we cannot see                                                                                                                                                                                                                                                  |

## Out of scope

- Running a command to find out what it does, dry runs, or a sandbox. The sandbox axis is reserved in the settings file and never changes what a level means.
- Reading the contents of scripts (`./build.sh`, `make`, `npm run x`). They are unsure by default; I8 lets the person say a named script is fine.
- Aliases and functions a person defines in their own shell start-up files. The login shell loads them; they are a known blind spot and the plan says so in the UI.

## How we will know it works

- The corpus (I0) is the contract: every row has an expected verdict, and a change that moves one is a decision in review.
- A differential run keeps the old scanners and the new graph honest until the old ones are deleted.
- Property tests on the front ends: no input makes a parser return `reads` for text that contains an unquoted `>` to a file, a `$(`, or a backtick, and appending `; <anything>` to a `reads` command never leaves it `reads` unless the tail is itself `reads`.
- Spec tests are tables: one row per flag and subcommand, each with its effect.
