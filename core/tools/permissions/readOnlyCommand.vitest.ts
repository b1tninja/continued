import { describe, expect, it } from "vitest";
import {
  classifyReadOnly,
  MAX_READ_ONLY_COMMAND_LENGTH,
  type ReadOnlyOptions,
} from "./readOnlyCommand";

const CLEAN: ReadOnlyOptions = {
  shell: "bash",
  cwd: "/repo",
  home: "/home/u",
  readGitConfig: () => "[core]\n\tbare = false\n",
  // /repo is a repository
  probe: (file) => (posix(file) === "/repo/.git" ? "dir" : undefined),
};

const posix = (file: string) => file.split(String.fromCharCode(92)).join("/");
const RUNS_A_PROGRAM = ["[core]", "	fsmonitor = /tmp/x", ""].join(
  String.fromCharCode(10),
);

const vouched = (command: string, opts: ReadOnlyOptions = CLEAN) =>
  classifyReadOnly(command, opts).vouched;
const why = (command: string, opts: ReadOnlyOptions = CLEAN) => {
  const r = classifyReadOnly(command, opts);
  return r.vouched ? "" : r.why;
};

describe("commands that only read", () => {
  it.each([
    "ls",
    "ls -la src",
    "cat README.md",
    "head -n 20 file.txt",
    "grep -rn TODO src",
    "rg --files -g '*.ts'",
    "find . -name '*.ts' -type f",
    "sed -n '10,20p' file.ts",
    "sort file.txt | uniq",
    "cat a.txt | wc -l",
    "ls && pwd",
    "ls 2>/dev/null",
    "ls > /dev/null 2>&1",
    "cd src; ls",
    "diff a.txt b.txt",
    "jq .name package.json",
    "git status",
    "git log --oneline -n 20",
    "git diff HEAD~1 -- src",
    "git show HEAD:README.md",
    "git branch --list",
    "git --no-pager log",
    "git stash list",
  ])("vouches %s", (command) => {
    expect(vouched(command)).toBe(true);
  });

  it("the claim says who judged and what it found", () => {
    expect(classifyReadOnly("git log | head", CLEAN)).toEqual({
      vouched: true,
      judge: "parser",
      claim: "only reads: git log, head",
    });
  });
});

describe("what is not understood is not vouched", () => {
  it.each([
    ["echo $(whoami)", "$"],
    ["echo `whoami`", "`"],
    ["echo ${HOME}", "$"],
    ["ls > out.txt", "redirect"],
    ["ls >> out.txt", "redirect"],
    ["cat < in.txt", "redirect"],
    ["ls &", "background"],
    ["ls\nrm -rf x", "newline"],
    ["(ls)", "("],
    ["FOO=bar ls", "environment prefix"],
    ['echo "$HOME"', "double quotes"],
    ["ls '", "unterminated"],
    ["ls | ", "ends on an operator"],
    ["cat \\\\server\\share\\file", "network path"],
  ])("%s", (command, reason) => {
    expect(vouched(command)).toBe(false);
    expect(why(command)).toContain(reason);
  });

  it("a command over 10,000 characters is not vouched", () => {
    expect(vouched("echo " + "a".repeat(MAX_READ_ONLY_COMMAND_LENGTH))).toBe(
      false,
    );
  });

  it("every part of a pipeline must read, so one write spoils it", () => {
    expect(vouched("cat a | tee b")).toBe(false);
    expect(why("ls && rm file")).toContain("rm is not on the read-only list");
  });
});

describe("commands that are never read-only", () => {
  it.each([
    "awk '{print}' f",
    "python -c 1",
    "node x.js",
    "xargs ls",
    "eval ls",
    "source x",
    "curl https://example.com",
    "wget https://example.com",
    "gh pr view 1",
    "git fetch",
    "git push",
    "git checkout main",
    "git commit -m x",
    "git reset --hard",
    "npm test",
    "rm -rf x",
    "mv a b",
    "touch a",
    "env ls",
  ])("%s", (command) => {
    expect(vouched(command)).toBe(false);
  });
});

describe("arguments that make a read-only command write or run", () => {
  it.each([
    ["find . -delete", "-delete"],
    ["find . -exec ls x +", "-exec"],
    ["find . -fprint out.txt", "-fprint"],
    ["sort -o out.txt in.txt", "-o"],
    ["sort --output=out.txt in.txt", "--output"],
    ["rg --pre ./x pattern", "--pre"],
    ["sed -i s/a/b/ f", "sed"],
    ["sed -n 'w out.txt' f", "print range"],
    ["sed 's/a/b/' f", "sed"],
    ["file -m magic f", "-m"],
    ["tail -f log.txt", "-f"],
    ["date -s 12:00", "-s"],
    ["uniq in.txt out.txt", "written"],
    ["jq -f prog.jq data.json", "-f"],
    ["hostname newname", "hostname"],
  ])("%s", (command, reason) => {
    expect(vouched(command)).toBe(false);
    expect(why(command)).toContain(reason);
  });
});

describe("git", () => {
  it("is not vouched after a cd: the folder it runs in was not checked", () => {
    expect(why("cd other && git log")).toContain("after cd");
    expect(why("cd /elsewhere; git status")).toContain("after cd");
    // a cd that follows git, or no git at all, changes nothing
    expect(vouched("git log && cd src")).toBe(true);
    expect(vouched("cd src && ls")).toBe(true);
  });

  it("looks up the tree for the repository, so a subfolder is checked too", () => {
    const scanned: string[] = [];
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      cwd: "/repo/packages/app",
      readGitConfig: (file) => {
        scanned.push(posix(file));
        return posix(file) === "/repo/.git/config" ? RUNS_A_PROGRAM : "";
      },
    };
    expect(vouched("git status", opts)).toBe(false);
    expect(scanned).toContain("/repo/.git/config");
  });

  it("is not vouched in a worktree or submodule, where .git is a file", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      probe: (file) => (posix(file) === "/repo/.git" ? "file" : undefined),
    };
    expect(why("git status", opts)).toContain("worktree or submodule");
    // reading files needs no git at all
    expect(vouched("ls", opts)).toBe(true);
  });

  it("outside any repository only the user's config can matter", () => {
    const opts: ReadOnlyOptions = { ...CLEAN, probe: () => undefined };
    expect(vouched("git status", opts)).toBe(true);
    expect(
      vouched("git status", { ...opts, readGitConfig: () => RUNS_A_PROGRAM }),
    ).toBe(false);
  });

  it("is not vouched without a folder to check", () => {
    expect(why("git status", { ...CLEAN, cwd: undefined })).toContain(
      "without a folder",
    );
  });

  it.each([
    "[core]\n\tfsmonitor = /tmp/x\n",
    "[core]\n\thooksPath = /tmp/hooks\n",
    "[core]\n\tsshCommand = ssh -i key\n",
    '[diff "x"]\n\ttextconv = cat\n',
    '[filter "lfs"]\n\tclean = git-lfs clean\n',
    "[include]\n\tpath = /tmp/more\n",
    '[includeIf "gitdir:~/"]\n\tpath = x\n',
  ])("is not vouched when a config can run programs: %s", (config) => {
    const opts = { ...CLEAN, readGitConfig: () => config };
    expect(vouched("git status", opts)).toBe(false);
    expect(why("git log", opts)).toContain("can run programs");
  });

  it("checks the user's config as well as the repository's", () => {
    const opts: ReadOnlyOptions = {
      ...CLEAN,
      readGitConfig: (file) =>
        file.endsWith(".gitconfig") ? "[core]\n\tfsmonitor = x\n" : "",
    };
    expect(vouched("git status", opts)).toBe(false);
  });

  it.each([
    "git -c core.fsmonitor=x status",
    "git -C /other status",
    "git --git-dir=/x status",
    "git --exec-path=/x status",
    "git -p log",
    "git log --output=out.txt",
    "git diff --output out.txt",
    "git diff --ext-diff",
    "git grep --open-files-in-pager=less x",
    "git branch -D old",
    "git branch new-branch",
    "git tag v1",
    "git remote add x y",
    "git remote update",
    "git stash drop",
    "git cat-file --batch",
    "git config user.name x",
  ])("refuses what changes what runs: %s", (command) => {
    expect(vouched(command)).toBe(false);
  });
});

const PS: ReadOnlyOptions = { ...CLEAN, shell: "powershell" };
const ZSH: ReadOnlyOptions = { ...CLEAN, shell: "zsh" };

describe("the shell decides what a command is", () => {
  it("without a shell nothing is vouched, and cmd and unknown shells are not parsed", () => {
    expect(why("ls", { ...CLEAN, shell: undefined })).toContain("not known");
    expect(why("dir", { ...CLEAN, shell: "cmd" })).toContain(
      "cmd is not parsed",
    );
    expect(why("ls", { ...CLEAN, shell: "unknown" })).toContain("not parsed");
  });

  it("sh and zsh read what bash reads", () => {
    for (const shell of ["sh", "zsh", "bash"] as const) {
      expect(vouched("ls -la | head", { ...CLEAN, shell })).toBe(true);
      expect(vouched("echo $(whoami)", { ...CLEAN, shell })).toBe(false);
    }
  });

  it("a backslash in a POSIX shell is an escape, so it is not understood", () => {
    // bash runs the rm: the \' is a quote that does not open one. A scanner
    // that read the backslash as a letter would see one harmless echo.
    const attack = String.raw`echo \'; rm -rf x; echo \'`;
    for (const shell of ["bash", "zsh", "sh"] as const) {
      expect(why(attack, { ...CLEAN, shell })).toContain("backslash");
      expect(why(String.raw`ls a\ b`, { ...CLEAN, shell })).toContain(
        "backslash",
      );
    }
  });

  it("zsh expands =cmd, so it is not understood there", () => {
    expect(why("=ls", ZSH)).toContain("zsh");
    // zsh expands it in an argument as well
    expect(why("echo =ls", ZSH)).toContain("zsh");
    expect(vouched("echo a=b", ZSH)).toBe(true);
  });

  it("date, find and the rest are checked against the shell's own list", () => {
    expect(vouched("date")).toBe(true);
    expect(vouched("date", PS)).toBe(false);
    expect(vouched("find . -name x", PS)).toBe(false);
    expect(why("find . -name x", PS)).toContain("PowerShell read-only list");
  });
});

describe("PowerShell", () => {
  it.each([
    "Get-ChildItem -Recurse src",
    "gci src",
    "ls src",
    "Get-Content README.md | Select-Object -First 10",
    "cat README.md | Select-String TODO",
    "dir | Sort-Object Length",
    "Get-Item C:\\src\\a.ts",
    "ls C:\\Users\\me\\src",
    "Test-Path .git",
    "rg --files -g '*.ts'",
    "git status",
    "git log --oneline",
    "Set-Location src; ls",
  ])("vouches %s", (command) => {
    expect(vouched(command, PS)).toBe(true);
  });

  it("a backslash is a path separator there, not an escape", () => {
    expect(vouched("Get-Content src\\a.ts", PS)).toBe(true);
  });

  it.each([
    ["Get-ChildItem @args", "@"],
    ["ls $env:USERPROFILE", "$"],
    ["Get-Content `x", "`"],
    ["Get-Content a.txt > out.txt", "redirect"],
    ["Get-Content (Get-Item x)", "("],
    ["& ls", "background"],
    ["Remove-Item x", "not on the PowerShell read-only list"],
    ["Set-Content a.txt hi", "not on the PowerShell read-only list"],
    ["Tee-Object -FilePath x", "not on the PowerShell read-only list"],
    ["Invoke-Expression 'ls'", "not on the PowerShell read-only list"],
    ["iex ls", "not on the PowerShell read-only list"],
    ["curl https://example.com", "not on the PowerShell read-only list"],
    ["Start-Process notepad", "not on the PowerShell read-only list"],
    ["powershell -EncodedCommand AAAA", "not on the PowerShell read-only list"],
    ["\\\\server\\share\\f", "network path"],
  ])("%s", (command, reason) => {
    expect(vouched(command, PS)).toBe(false);
    expect(why(command, PS)).toContain(reason);
  });

  it("git after Set-Location is not vouched either", () => {
    expect(why("Set-Location other; git log", PS)).toContain("after cd");
    expect(why("sl other; git log", PS)).toContain("after cd");
  });

  it("the claim names what it found", () => {
    expect(
      classifyReadOnly("Get-Content a | Select-Object -First 2", PS),
    ).toEqual({
      vouched: true,
      judge: "parser",
      claim: "only reads: get-content, select-object",
    });
  });
});
