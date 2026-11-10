import type { ShellKind } from "../../../util/shell";

/**
 * What a command does, for the command-analysis plan (plans/command-analysis.md,
 * P0). Each case says what is TRUE of the command in the shell named, not what
 * a scanner makes of it: a scanner that cannot tell is allowed to say "unsure",
 * and a scanner that says "reads" for anything that is not is a bug.
 *
 * - reads: it only reads local files and state: no writes, no program run on
 *   the side, no network. Reading a secret is still a read; what asks about it
 *   is the protected-path scan (`protects`), a separate question.
 * - writes: it changes something (a file, the repository, the system, the
 *   environment of other processes, a remote), or it runs a program that does.
 * - unsure: what it does depends on something we cannot see (a script, an
 *   expansion, a network answer), or it uses the network without writing.
 *
 * `protects` is what a scan for protected paths should find, and `resolves` is
 * the program and subcommand a deny or ask rule written as text should see.
 */
export type Verdict = "reads" | "writes" | "unsure";
export type ProtectedKind = "secret" | "config" | "network";

export interface VerdictCase {
  /** The shells in which the command means this */
  shells: ShellKind[];
  command: string;
  verdict: Verdict;
  why: string;
  /** What a protected-path scan should find; absent means the case does not test it */
  protects?: ProtectedKind | "none";
  /** What a rule written as text should see; absent means the case does not test it */
  resolves?: string;
}

const POSIX: ShellKind[] = ["bash", "zsh", "sh"];
const BASH_ZSH: ShellKind[] = ["bash", "zsh"];
const PS: ShellKind[] = ["powershell"];
const CMD: ShellKind[] = ["cmd"];

type Extra = Pick<VerdictCase, "protects" | "resolves">;
const c = (
  shells: ShellKind[],
  command: string,
  verdict: Verdict,
  why: string,
  extra: Extra = {},
): VerdictCase => ({ shells, command, verdict, why, ...extra });

export const VERDICT_CASES: VerdictCase[] = [
  // ---- POSIX: reads
  c(POSIX, "ls", "reads", "lists a directory"),
  c(POSIX, "ls -la src", "reads", "lists a directory"),
  c(POSIX, "ls *.ts", "reads", "a glob in a listing"),
  c(POSIX, "ls ~", "reads", "the home directory"),
  c(POSIX, "cat README.md", "reads", "prints a file", { protects: "none" }),
  c(POSIX, "head -n 5 a.txt", "reads", "prints the start of a file"),
  c(POSIX, "tail -n 20 log.txt", "reads", "prints the end of a file"),
  c(POSIX, "wc -l a.txt", "reads", "counts lines"),
  c(POSIX, "grep -rn TODO src", "reads", "searches files"),
  c(POSIX, "rg -n foo", "reads", "searches files"),
  c(POSIX, "find . -name '*.ts' -type f", "reads", "find without an action"),
  c(POSIX, "sort a.txt | uniq -c", "reads", "a pipeline of readers"),
  c(POSIX, "cat a.txt | head -3", "reads", "a pipeline of readers"),
  c(POSIX, "pwd", "reads", "prints the folder"),
  c(POSIX, "echo hello", "reads", "prints text"),
  c(POSIX, 'echo "hi there"', "reads", "prints quoted text"),
  c(POSIX, "stat a.txt", "reads", "file metadata"),
  c(POSIX, "du -sh .", "reads", "sizes"),
  c(POSIX, "diff a.txt b.txt", "reads", "compares files"),
  c(POSIX, "jq .name package.json", "reads", "reads JSON"),
  c(POSIX, "sed -n '1,10p' f.txt", "reads", "prints a range"),
  c(POSIX, "git status", "reads", "repository state", {
    resolves: "git status",
  }),
  c(POSIX, "git log --oneline -5", "reads", "history"),
  c(POSIX, "git diff HEAD~1", "reads", "differences"),
  c(POSIX, "git show HEAD:README.md", "reads", "a file at a commit"),
  c(POSIX, "git branch --list", "reads", "lists branches"),
  c(POSIX, "ls 2>/dev/null", "reads", "stderr thrown away"),
  c(POSIX, "ls > /dev/null 2>&1", "reads", "output thrown away"),
  c(POSIX, "ls && pwd", "reads", "two readers"),
  c(POSIX, "cd src && ls", "reads", "changes folder, reads"),
  c(POSIX, "tree -L 2", "reads", "lists a tree"),
  c(POSIX, "which node", "reads", "finds a program"),
  c(POSIX, "basename /a/b.txt", "reads", "string work"),
  c(POSIX, "realpath .", "reads", "resolves a path"),
  c(POSIX, "date", "reads", "prints the time"),
  c(POSIX, "whoami", "reads", "prints the user"),
  c(POSIX, "uname -a", "reads", "prints the system"),
  c(POSIX, "file a.bin", "reads", "identifies a file"),
  c(POSIX, "sha256sum a.bin", "reads", "hashes a file"),
  c(POSIX, "cat a.txt 2>&1", "reads", "stderr to stdout"),
  c(POSIX, "ls a\\ b", "reads", "an escaped space is one word"),
  c(POSIX, "ls {a,b}", "reads", "brace expansion of names"),
  c(POSIX, "echo $((1+2))", "reads", "arithmetic"),
  c(POSIX, "cat <(ls)", "reads", "process substitution of a reader"),
  c(
    POSIX,
    "ls $HOME",
    "reads",
    "a variable in a listing, though what it holds is not known here",
  ),
  // ---- POSIX: writes
  c(POSIX, "rm -rf build", "writes", "deletes"),
  c(POSIX, "rm a.txt", "writes", "deletes", { resolves: "rm" }),
  c(POSIX, "mv a b", "writes", "moves"),
  c(POSIX, "cp a b", "writes", "copies"),
  c(POSIX, "mkdir x", "writes", "creates a folder"),
  c(POSIX, "touch a", "writes", "creates or touches a file"),
  c(POSIX, "tee out.txt", "writes", "writes a file"),
  c(POSIX, "echo hi > out.txt", "writes", "a redirect to a file"),
  c(POSIX, "echo hi >> out.txt", "writes", "an append"),
  c(POSIX, "cat a > b", "writes", "a redirect to a file"),
  c(POSIX, "cat a | tee b", "writes", "tee writes"),
  c(POSIX, "sed -i s/a/b/ f.txt", "writes", "edits in place"),
  c(POSIX, "git commit -m x", "writes", "commits", { resolves: "git commit" }),
  c(POSIX, "git push origin main", "writes", "changes a remote", {
    resolves: "git push",
  }),
  c(POSIX, "git checkout main", "writes", "changes the worktree", {
    resolves: "git checkout",
  }),
  c(POSIX, "git reset --hard", "writes", "discards changes", {
    resolves: "git reset",
  }),
  c(POSIX, "git add .", "writes", "stages", { resolves: "git add" }),
  c(POSIX, "npm install", "writes", "installs packages"),
  c(POSIX, "pip install x", "writes", "installs packages"),
  c(POSIX, "chmod +x a", "writes", "changes a mode"),
  c(POSIX, "ln -s a b", "writes", "creates a link"),
  c(POSIX, "dd if=a of=b", "writes", "copies bytes"),
  c(POSIX, "truncate -s 0 f", "writes", "empties a file"),
  c(POSIX, "rmdir x", "writes", "deletes a folder"),
  c(POSIX, "curl -o f https://example.com", "writes", "downloads to a file"),
  c(POSIX, "wget https://example.com", "writes", "downloads to a file"),
  c(POSIX, "find . -delete", "writes", "find with an action"),
  c(POSIX, "sort -o out.txt a.txt", "writes", "sort writes its output file"),
  c(POSIX, "ls; rm x", "writes", "the second command deletes"),
  c(POSIX, "ls && rm x", "writes", "the second command deletes"),
  c(POSIX, "xargs rm", "writes", "xargs runs rm"),
  c(POSIX, "ls | xargs rm", "writes", "xargs runs rm"),
  c(POSIX, "git push", "writes", "changes a remote", { resolves: "git push" }),
  c(POSIX, "/usr/bin/git push origin main", "writes", "a path to git", {
    resolves: "git push",
  }),
  c(POSIX, "git -C . push", "writes", "a global flag before push", {
    resolves: "git push",
  }),
  c(POSIX, "sudo rm x", "writes", "a wrapper around rm", { resolves: "rm" }),
  c(POSIX, "env FOO=1 git push", "writes", "a wrapper around git push", {
    resolves: "git push",
  }),
  c(POSIX, "timeout 30 git push", "writes", "a wrapper around git push", {
    resolves: "git push",
  }),
  c(POSIX, "bash -c 'git push'", "writes", "a nested shell", {
    resolves: "git push",
  }),
  c(
    POSIX,
    "echo \\'; rm -rf x; echo \\'",
    "writes",
    "the escaped quote does not open one, so the rm runs",
  ),
  // ---- POSIX: unsure
  c(POSIX, "ls $(whoami)", "unsure", "a substitution"),
  c(POSIX, "ls `whoami`", "unsure", "a substitution"),
  c(POSIX, "eval ls", "unsure", "runs a string"),
  c(POSIX, "bash -c ls", "unsure", "a nested shell"),
  c(POSIX, "xargs ls", "unsure", "runs a program on input"),
  c(POSIX, "awk '{print}' f", "unsure", "a program language"),
  c(POSIX, "python -c 'print(1)'", "unsure", "an interpreter"),
  c(POSIX, "node x.js", "unsure", "a script"),
  c(POSIX, "./script.sh", "unsure", "a script"),
  c(POSIX, "make", "unsure", "runs a makefile"),
  c(POSIX, "npm test", "unsure", "runs a package script"),
  c(POSIX, "cat file | sh", "unsure", "runs the contents of a file"),
  c(
    POSIX,
    "FOO=bar ls",
    "unsure",
    "an environment prefix can change what runs",
  ),
  c(POSIX, "curl https://example.com", "unsure", "the network, no local write"),
  c(POSIX, "gh pr view 1", "unsure", "the network"),
  c(POSIX, "git fetch", "unsure", "the network and refs"),
  c(POSIX, "sleep 1 &", "unsure", "a background job"),
  c(POSIX, "(ls)", "unsure", "a subshell"),
  // ---- bash and zsh: protected paths, and a few that differ
  c(
    BASH_ZSH,
    "cat ~/.aws/credentials",
    "reads",
    "a read of a credentials file: the protected-path scan is what asks",
    { protects: "secret" },
  ),
  c(POSIX, "cat ~/.ssh/id_rsa", "reads", "a read of a private key", {
    protects: "secret",
  }),
  c(POSIX, "echo $AWS_SECRET_ACCESS_KEY", "reads", "prints a secret variable", {
    protects: "secret",
  }),
  c(POSIX, "printenv", "reads", "prints every variable, secrets included", {
    protects: "secret",
  }),
  c(POSIX, "echo x > .git/hooks/pre-commit", "writes", "a git hook", {
    protects: "config",
  }),
  c(POSIX, "cp a .github/workflows/ci.yml", "writes", "a CI file", {
    protects: "config",
  }),
  c(POSIX, "echo x >> ~/.bashrc", "writes", "a shell start-up file", {
    protects: "config",
  }),
  c(POSIX, "cat //server/share/f", "unsure", "a network path", {
    protects: "network",
  }),
  c(POSIX, "ls src", "reads", "an ordinary folder", { protects: "none" }),
  // ---- zsh only
  c(["zsh"], "ls =ls", "reads", "=ls expands to a path"),
  c(["zsh"], "print -l *(.)", "reads", "lists plain files"),
  c(["zsh"], "echo *(e:'rm x':)", "writes", "a glob qualifier runs code"),
  c(["zsh"], "rm *", "writes", "deletes", { resolves: "rm" }),
  c(["zsh"], "ls **/*.ts", "reads", "recursive glob"),
  // ---- PowerShell: reads
  c(PS, "Get-ChildItem", "reads", "lists a folder"),
  c(PS, "Get-ChildItem -Recurse src", "reads", "lists a tree"),
  c(PS, "gci", "reads", "an alias of Get-ChildItem"),
  c(PS, "ls", "reads", "an alias of Get-ChildItem"),
  c(PS, "dir", "reads", "an alias of Get-ChildItem"),
  c(PS, "Get-Content a.txt", "reads", "prints a file"),
  c(PS, "gc a.txt", "reads", "an alias of Get-Content"),
  c(PS, "cat a.txt", "reads", "an alias of Get-Content"),
  c(PS, "type a.txt", "reads", "an alias of Get-Content"),
  c(PS, "Select-String TODO a.txt", "reads", "searches a file"),
  c(PS, "sls x f.txt", "reads", "an alias of Select-String"),
  c(PS, "Get-Location", "reads", "the folder"),
  c(PS, "pwd", "reads", "an alias of Get-Location"),
  c(PS, "Get-Item a.txt", "reads", "an item"),
  c(PS, "Test-Path a.txt", "reads", "an existence test"),
  c(PS, "Resolve-Path .", "reads", "resolves a path"),
  c(PS, "Split-Path a\\b.txt", "reads", "string work on a path"),
  c(PS, "Get-FileHash a.txt", "reads", "hashes a file"),
  c(PS, "Get-Date", "reads", "the time"),
  c(
    PS,
    "Get-Content a.txt | Select-Object -First 5",
    "reads",
    "a pipeline of readers",
  ),
  c(PS, "ls | Sort-Object Length", "reads", "a pipeline of readers"),
  c(PS, "Get-ChildItem | Measure-Object", "reads", "a pipeline of readers"),
  c(PS, "git status", "reads", "repository state", { resolves: "git status" }),
  c(PS, "git log --oneline", "reads", "history"),
  c(PS, "rg x", "reads", "searches"),
  c(PS, "Set-Location src", "reads", "changes folder"),
  c(PS, "cd src", "reads", "changes folder"),
  c(PS, "ls C:\\src", "reads", "a Windows path"),
  c(PS, "Get-Content C:\\a\\b.txt", "reads", "a Windows path"),
  c(PS, "Write-Output hi", "reads", "prints text"),
  c(PS, "echo hi", "reads", "an alias of Write-Output"),
  c(PS, "Get-Process", "reads", "lists processes"),
  c(
    PS,
    "Get-ChildItem | Where-Object { $_.Length -gt 1 }",
    "reads",
    "a filter script block",
  ),
  c(PS, "Get-ChildItem -Rec src", "reads", "an abbreviated parameter"),
  c(PS, "gci -File", "reads", "an alias with a parameter"),
  c(PS, "Get-Content -Path:a.txt", "reads", "the colon form of a parameter"),
  c(PS, "Get-Content a.txt -Tail 5", "reads", "the end of a file"),
  c(PS, "gc -TotalCount 3 a.txt", "reads", "the start of a file"),
  c(PS, "Select-String -Pattern x -Path a.txt", "reads", "named parameters"),
  c(PS, "Get-Process -Name node", "reads", "one process"),
  c(PS, "Get-Service -Name x", "reads", "one service"),
  c(
    PS,
    "ls | Sort-Object -Property Length -Descending | Select-Object -First 3",
    "reads",
    "a pipeline of readers",
  ),
  c(
    PS,
    "Get-Content a.txt -ErrorAction SilentlyContinue",
    "reads",
    "a common parameter",
  ),
  // ---- PowerShell: writes
  c(PS, "Remove-Item a.txt", "writes", "deletes", { resolves: "Remove-Item" }),
  c(PS, "rm a.txt", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "del a.txt", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "ri a.txt", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "Remove-Item -Recurse -Force x", "writes", "deletes a tree", {
    resolves: "Remove-Item",
  }),
  c(PS, "Set-Content a.txt hi", "writes", "writes a file"),
  c(PS, "Add-Content a.txt hi", "writes", "appends"),
  c(PS, "Out-File a.txt", "writes", "writes a file"),
  c(PS, "ls > out.txt", "writes", "a redirect to a file"),
  c(PS, "echo hi > out.txt", "writes", "a redirect to a file"),
  c(PS, "New-Item x", "writes", "creates"),
  c(PS, "ni x", "writes", "an alias of New-Item"),
  c(PS, "Copy-Item a b", "writes", "copies"),
  c(PS, "cp a b", "writes", "an alias of Copy-Item"),
  c(PS, "copy a b", "writes", "an alias of Copy-Item"),
  c(PS, "Move-Item a b", "writes", "moves"),
  c(PS, "mv a b", "writes", "an alias of Move-Item"),
  c(PS, "mkdir x", "writes", "creates a folder"),
  c(PS, "Rename-Item a b", "writes", "renames"),
  c(PS, "Tee-Object -FilePath x", "writes", "writes a file"),
  c(PS, "Clear-Content a.txt", "writes", "empties a file"),
  c(PS, "Stop-Process -Name x", "writes", "ends a process"),
  c(PS, "Restart-Service x", "writes", "restarts a service"),
  c(PS, "git commit -m x", "writes", "commits", { resolves: "git commit" }),
  c(PS, "git push", "writes", "changes a remote", { resolves: "git push" }),
  c(PS, "& git push", "writes", "the call operator", { resolves: "git push" }),
  c(PS, "git.exe push", "writes", "an .exe name", { resolves: "git push" }),
  c(PS, "npm install", "writes", "installs packages"),
  c(PS, "ls; Remove-Item a", "writes", "the second command deletes"),
  c(
    PS,
    "Get-ChildItem && Remove-Item a",
    "writes",
    "PowerShell 7: && then deletes",
  ),
  c(PS, "ls | ForEach-Object { Remove-Item $_ }", "writes", "deletes each"),
  c(PS, 'powershell -Command "git push"', "writes", "a nested PowerShell", {
    resolves: "git push",
  }),
  c(PS, "cmd /c git push", "writes", "a nested cmd", { resolves: "git push" }),
  c(PS, "wsl git push", "writes", "a nested Linux shell", {
    resolves: "git push",
  }),
  c(PS, "Start-Process git -ArgumentList push", "writes", "runs git push", {
    resolves: "git push",
  }),
  c(
    PS,
    "Remove-Item -Rec x",
    "writes",
    "an abbreviated parameter on a deleting cmdlet",
    { resolves: "Remove-Item" },
  ),
  c(PS, "rd x", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "rmdir x", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "erase a.txt", "writes", "an alias of Remove-Item", {
    resolves: "Remove-Item",
  }),
  c(PS, "kill 123", "writes", "an alias of Stop-Process", {
    resolves: "Stop-Process",
  }),
  c(PS, "sc a.txt hi", "writes", "an alias of Set-Content", {
    resolves: "Set-Content",
  }),
  c(PS, "mi a b", "writes", "an alias of Move-Item", { resolves: "Move-Item" }),
  c(PS, "rni a b", "writes", "an alias of Rename-Item", {
    resolves: "Rename-Item",
  }),
  c(PS, "cpi a b", "writes", "an alias of Copy-Item", {
    resolves: "Copy-Item",
  }),
  // ---- PowerShell: unsure
  c(PS, "iwr https://example.com", "unsure", "the network (an alias)"),
  c(PS, "irm https://example.com", "unsure", "the network (an alias)"),
  c(PS, "Get-ChildItem -Foo", "unsure", "a parameter the cmdlet does not have"),
  c(PS, "saps x", "unsure", "an alias of Start-Process"),
  c(PS, "Invoke-Expression 'ls'", "unsure", "runs a string"),
  c(PS, "iex ls", "unsure", "an alias of Invoke-Expression"),
  c(
    PS,
    "powershell -EncodedCommand AAAA",
    "unsure",
    "a command we cannot read",
  ),
  c(PS, "& $cmd", "unsure", "a call through a variable"),
  c(PS, ". .\\script.ps1", "unsure", "dot-sources a script"),
  c(PS, ".\\build.ps1", "unsure", "a script"),
  c(PS, "Start-Process notepad", "unsure", "runs a program"),
  c(PS, "Invoke-WebRequest https://example.com", "unsure", "the network"),
  c(PS, "curl https://example.com", "unsure", "the network (an alias in 5.1)"),
  c(PS, "wget https://example.com", "unsure", "the network (an alias in 5.1)"),
  c(PS, "ls $env:PATH", "unsure", "an expansion"),
  c(PS, "Get-ChildItem @args", "unsure", "a splat"),
  c(PS, "Get-Content `a", "unsure", "a backtick escape"),
  c(PS, "Set-ExecutionPolicy Bypass", "unsure", "changes how scripts run"),
  // ---- PowerShell: protected paths
  c(PS, "Get-Content ~\\.ssh\\id_rsa", "reads", "a read of a private key", {
    protects: "secret",
  }),
  c(
    PS,
    "Get-Content $env:USERPROFILE\\.aws\\credentials",
    "reads",
    "a read of a credentials file",
    { protects: "secret" },
  ),
  c(PS, "Set-Content .git\\hooks\\pre-commit x", "writes", "a git hook", {
    protects: "config",
  }),
  c(PS, "Copy-Item a .github\\workflows\\ci.yml", "writes", "a CI file", {
    protects: "config",
  }),
  c(PS, "Get-Content \\\\server\\share\\f", "unsure", "a network path", {
    protects: "network",
  }),
  c(PS, "Get-ChildItem src", "reads", "an ordinary folder", {
    protects: "none",
  }),
  // ---- cmd
  c(CMD, "dir", "reads", "lists a folder"),
  c(CMD, "dir /s", "reads", "lists a tree"),
  c(CMD, "type a.txt", "reads", "prints a file"),
  c(CMD, "cd", "reads", "prints the folder"),
  c(CMD, "cd src", "reads", "changes folder"),
  c(CMD, "echo hi", "reads", "prints text"),
  c(CMD, "where git", "reads", "finds a program"),
  c(CMD, "ver", "reads", "prints the version"),
  c(CMD, "findstr x f.txt", "reads", "searches a file"),
  c(CMD, "tree", "reads", "lists a tree"),
  c(CMD, "set", "reads", "lists variables"),
  c(CMD, "del a.txt", "writes", "deletes"),
  c(CMD, "erase a.txt", "writes", "deletes"),
  c(CMD, "rd /s /q x", "writes", "deletes a tree"),
  c(CMD, "rmdir x", "writes", "deletes a folder"),
  c(CMD, "copy a b", "writes", "copies"),
  c(CMD, "xcopy a b", "writes", "copies"),
  c(CMD, "robocopy a b", "writes", "copies"),
  c(CMD, "move a b", "writes", "moves"),
  c(CMD, "ren a b", "writes", "renames"),
  c(CMD, "md x", "writes", "creates a folder"),
  c(CMD, "mkdir x", "writes", "creates a folder"),
  c(CMD, "echo hi > out.txt", "writes", "a redirect to a file"),
  c(CMD, "type a.txt > b.txt", "writes", "a redirect to a file"),
  c(CMD, "date 1-1-2020", "writes", "sets the system date"),
  c(CMD, "time 12:00", "writes", "sets the system time"),
  c(CMD, "attrib +r a.txt", "writes", "changes attributes"),
  c(CMD, "mklink a b", "writes", "creates a link"),
  c(CMD, "taskkill /f /im x.exe", "writes", "ends a process"),
  c(CMD, "shutdown /s", "writes", "shuts the machine down"),
  c(CMD, "git commit -m x", "writes", "commits", { resolves: "git commit" }),
  c(CMD, "git push", "writes", "changes a remote", { resolves: "git push" }),
  c(CMD, "git.exe push", "writes", "an .exe name", { resolves: "git push" }),
  c(CMD, "npm install", "writes", "installs packages"),
  c(CMD, "if exist a.txt (del a.txt)", "writes", "deletes when it exists"),
  c(CMD, "dir & del a.txt", "writes", "the second command deletes"),
  c(CMD, "dir && del a.txt", "writes", "the second command deletes"),
  c(CMD, "cmd /c git push", "writes", "a nested cmd", { resolves: "git push" }),
  c(CMD, "call build.bat", "unsure", "a batch file"),
  c(CMD, "build.bat", "unsure", "a batch file"),
  c(CMD, "%COMSPEC% /c dir", "unsure", "an expansion before parsing"),
  c(CMD, "dir %USERPROFILE%", "reads", "an expansion in a listing"),
  c(CMD, "echo %PATH%", "reads", "an expansion in an echo"),
  c(
    CMD,
    "for /f %i in ('dir') do echo %i",
    "unsure",
    "runs a command per line",
  ),
  c(CMD, "start notepad", "unsure", "runs a program"),
  c(CMD, "curl https://example.com", "unsure", "the network"),
  c(
    CMD,
    "certutil -urlcache -f https://example.com f",
    "writes",
    "downloads to a file",
  ),
  c(CMD, "powershell -c ls", "unsure", "a nested PowerShell"),
  c(
    CMD,
    "type %USERPROFILE%\\.ssh\\id_rsa",
    "reads",
    "a read of a private key",
    { protects: "secret" },
  ),
  c(CMD, "copy a .github\\workflows\\ci.yml", "writes", "a CI file", {
    protects: "config",
  }),
  c(CMD, "type \\\\server\\share\\f", "unsure", "a network path", {
    protects: "network",
  }),
  c(CMD, "dir src", "reads", "an ordinary folder", { protects: "none" }),
];

/** The cases that apply to one shell. */
export function casesFor(shell: ShellKind): VerdictCase[] {
  return VERDICT_CASES.filter((k) => k.shells.includes(shell));
}
