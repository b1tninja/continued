import type { ShellKind } from "../../util/shell";
import { isPosixShell } from "../../util/shell";
import { scanCommand } from "./shellScan";

/**
 * A command whose program does not exist is not run. The shell would only
 * report it after the call: after the earlier `&&` segments already ran, after
 * the person approved a command that could never work, and (PowerShell) with a
 * long error the model reads again and again before it retries the same
 * program. This file decides, from the text alone and an injected lookup,
 * whether a command is CERTAIN to fail that way. When anything is unsure
 * (a construct the scanner does not read, something an earlier segment may
 * have created, a wrapper that may supply the program) it answers undefined
 * and the command runs.
 */
export interface MissingBinaryContext {
  /** The shell that parses the command */
  shell: ShellKind;
  /** Whether a program of this name can be started where the command runs */
  hasProgram(name: string): boolean;
  /** The folder the command starts in (cmd also looks there) */
  cwd?: string;
}

export interface MissingBinaryProblem {
  /** The program that is not there */
  program: string;
  /** 0-based position among the command's segments */
  segment: number;
}

const POSIX_BUILTINS = new Set(
  (
    ": . [ [[ ]] alias bg bind break builtin caller cd command compgen complete compopt continue " +
    "declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history " +
    "jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set " +
    "shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait " +
    "time coproc"
  ).split(" "),
);
const ZSH_BUILTINS = new Set(
  (
    "autoload bindkey chdir emulate functions integer print rehash sched setopt unsetopt vared " +
    "whence where which zcompile zmodload zstyle noglob nocorrect r zle compdef"
  ).split(" "),
);
const POSIX_KEYWORDS = new Set(
  "if then else elif fi for while until do done case esac in select function { } ! [[ ]] time coproc".split(
    " ",
  ),
);
// The cmdlet aliases Windows PowerShell 5.1 defines (lowercase)
const POWERSHELL_ALIASES = new Set(
  (
    "ac asnp cat cd chdir clc clear clhy cli clp cls clv cnsn compare copy cp cpi cpp curl cvpa dbp " +
    "del diff dir dnsn ebp echo epal epcsv epsn erase etsn exsn fc fhx fl foreach ft fw gal gbp gc " +
    "gcb gci gcm gcs gdr ghy gi gin gjb gl gm gmo gp gps gpv group gsn gsnp gsv gtz gu gv gwmi h " +
    "history icm iex ihy ii ipal ipcsv ipmo ipsn irm ise iwmi iwr kill lp ls man md measure mi " +
    "mount move mp mv nal ndr ni nmo npssc nsn nv ogv oh popd ps pushd pwd r rbp rcjb rcsn rd rdr " +
    "ren ri rjb rm rmdir rmo rni rnp rp rsn rsnp rujb rv rvpa rwmi sajb sal saps sasv sbp sc " +
    "select set shcm si sl sleep sls sort sp spjb spps spsv start sv swmi tee trcm type wget where " +
    "wjb write"
  ).split(" "),
);
const POWERSHELL_KEYWORDS = new Set(
  (
    "if elseif else foreach for while do switch function filter param return break continue throw " +
    "trap try catch finally exit begin process end class using workflow"
  ).split(" "),
);
const CMD_BUILTINS = new Set(
  (
    "assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if " +
    "md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift " +
    "start time title type ver verify vol"
  ).split(" "),
);

/** Commands that run the rest of their line with a program they do not supply. */
const LOOK_THROUGH = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "nohup",
  "nice",
  "exec",
  "command",
]);
/** Their options that take a value */
const OPTION_WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set([
    "-u",
    "-g",
    "-h",
    "-p",
    "-C",
    "-D",
    "-R",
    "-T",
    "-U",
    "-r",
    "-t",
  ]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C"]),
  nice: new Set(["-n"]),
  time: new Set(["-f", "-o"]),
};

/** `which x`, `type x`, `command -v x` ask about a program: it is then guarded. */
const PROBES = new Set([
  "which",
  "where",
  "whereis",
  "type",
  "hash",
  "whence",
  "get-command",
  "gcm",
]);

/** Anything that can put a program on the PATH, define one or run arbitrary code */
const TAINT_NAMES = new Set(
  (
    ". source eval alias function cd chdir pushd popd sh bash zsh dash ash ksh fish pwsh powershell " +
    "iex invoke-expression set-alias sal new-alias nal set-item import-module ipmo set-location sl " +
    "refreshenv setx unalias"
  ).split(" "),
);
const INSTALLERS = new Set(
  (
    "npm pnpm yarn bun pip pip3 pipx uv apt apt-get dnf yum pacman brew winget choco scoop cargo go " +
    "gem snap zypper apk nix nix-env conda mamba rustup dotnet nvm sdk asdf mise pyenv fnm volta " +
    "install-module install-package"
  ).split(" "),
);
const INSTALL_WORDS = new Set(
  "install i add get -s -sy -syu -g --global tool use upgrade global ci sync".split(
    " ",
  ),
);

function isPathLike(name: string): boolean {
  return (
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith("~") ||
    name.startsWith(".") ||
    /^[A-Za-z]:/.test(name)
  );
}

function isBuiltin(name: string, shell: ShellKind): boolean {
  if (isPosixShell(shell)) {
    return (
      POSIX_BUILTINS.has(name) ||
      POSIX_KEYWORDS.has(name) ||
      (shell === "zsh" && ZSH_BUILTINS.has(name))
    );
  }
  const lower = name.toLowerCase();
  if (shell === "powershell") {
    // Verb-Noun is a cmdlet or a function: not for this check to doubt
    return (
      POWERSHELL_ALIASES.has(lower) ||
      POWERSHELL_KEYWORDS.has(lower) ||
      /^[a-z]+-[a-z]/i.test(name)
    );
  }
  return CMD_BUILTINS.has(lower);
}

/** The program a segment starts, looking through sudo, env, time and the like. */
function programOf(words: string[], shell: ShellKind): string | undefined {
  if (!isPosixShell(shell)) return words[0];
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return undefined;
    if (!LOOK_THROUGH.has(w)) return w;
    const withValue = OPTION_WITH_VALUE[w];
    i++;
    for (;;) {
      const next = words[i];
      if (next === undefined) return undefined;
      if (next === "--") {
        i++;
        break;
      }
      if (next.startsWith("-")) {
        // env -S splits a string into a command: not read
        if (w === "env" && next === "-S") return undefined;
        i += withValue?.has(next) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
        i++;
        continue;
      }
      break;
    }
  }
}

/** True when this segment may put a program in place for the ones after it. */
function createsPrograms(
  name: string,
  words: string[],
  shell: ShellKind,
): boolean {
  const lower = isPosixShell(shell) ? name : name.toLowerCase();
  if (TAINT_NAMES.has(lower)) return true;
  const args = words.slice(1).map((w) => w.toLowerCase());
  if (lower === "export" || lower === "set" || lower === "declare") {
    return args.some((a) => /^path(?:=|$)/.test(a));
  }
  if (INSTALLERS.has(lower)) return args.some((a) => INSTALL_WORDS.has(a));
  return false;
}

/**
 * The first program of the command that is certainly not there, or undefined.
 * Every segment of a `&&`, `;` or `|` chain is read in order. A program
 * after an earlier segment that may create it, or beside a fallback (`||`),
 * is not doubted.
 */
export function missingBinaryProblem(
  command: string,
  ctx: MissingBinaryContext,
): MissingBinaryProblem | undefined {
  const scan = scanCommand(command, ctx.shell);
  if (!scan.ok) return undefined;
  const { commands, joins } = scan.graph;
  const guarded = new Set<string>();
  for (let i = 0; i < commands.length; i++) {
    const words = commands[i].words;
    const first = words[0];
    const isCommandProbe =
      first === "command" && /^-[vV]$/.test(words[1] ?? "");
    if (isCommandProbe || PROBES.has(first.toLowerCase())) {
      for (const w of words.slice(1)) if (!w.startsWith("-")) guarded.add(w);
      continue;
    }
    const name = programOf(words, ctx.shell);
    if (name === undefined) return undefined;
    // A fallback (`a || b`): either side may be the one that is meant to fail
    const beside = joins[i - 1] === "||" || joins[i] === "||";
    const checkable =
      !beside &&
      !guarded.has(name) &&
      !isPathLike(name) &&
      /^[A-Za-z0-9_+@][A-Za-z0-9._+@-]*$/.test(name) &&
      !isBuiltin(name, ctx.shell);
    if (checkable) {
      if (ctx.shell === "cmd" && ctx.cwd === undefined) return undefined;
      if (!ctx.hasProgram(name)) return { program: name, segment: i };
    }
    if (createsPrograms(name, words, ctx.shell)) return undefined;
    // Shell keywords open a construct whose body is not read
    if (isPosixShell(ctx.shell) && POSIX_KEYWORDS.has(name)) return undefined;
  }
  return undefined;
}

// ---- the answer ----

type Pm = "winget" | "apt" | "dnf" | "pacman" | "brew";
const PYTHON = {
  winget: "Python.Python.3.12",
  apt: "python3",
  dnf: "python3",
  pacman: "python",
  brew: "python",
};
const PIP = {
  ...PYTHON,
  apt: "python3-pip",
  dnf: "python3-pip",
  pacman: "python-pip",
};
const NODE = {
  winget: "OpenJS.NodeJS.LTS",
  apt: "nodejs",
  dnf: "nodejs",
  pacman: "nodejs",
  brew: "node",
};
const INSTALL_HINTS: Record<string, Partial<Record<Pm, string>>> = {
  python: PYTHON,
  python3: PYTHON,
  pip: PIP,
  pip3: PIP,
  node: NODE,
  npm: { ...NODE, apt: "npm", dnf: "npm", pacman: "npm" },
  git: {
    winget: "Git.Git",
    apt: "git",
    dnf: "git",
    pacman: "git",
    brew: "git",
  },
  rg: {
    winget: "BurntSushi.ripgrep.MSVC",
    apt: "ripgrep",
    dnf: "ripgrep",
    pacman: "ripgrep",
    brew: "ripgrep",
  },
  fd: {
    winget: "sharkdp.fd",
    apt: "fd-find",
    dnf: "fd-find",
    pacman: "fd",
    brew: "fd",
  },
  jq: { winget: "jqlang.jq", apt: "jq", dnf: "jq", pacman: "jq", brew: "jq" },
  make: { apt: "make", dnf: "make", pacman: "make", brew: "make" },
  go: {
    winget: "GoLang.Go",
    apt: "golang-go",
    dnf: "golang",
    pacman: "go",
    brew: "go",
  },
};

interface Alternative {
  name: string;
  /** Offered only when this program (its first word) is there; otherwise it is a shell builtin */
  lookup: boolean;
  /** Offered only in this family of shell */
  only?: "posix" | "powershell" | "cmd";
}
const ALTERNATIVES: Record<string, Alternative[]> = {
  python: [
    { name: "python3", lookup: true },
    { name: "py", lookup: true },
  ],
  python3: [
    { name: "python", lookup: true },
    { name: "py", lookup: true },
  ],
  pip: [
    { name: "pip3", lookup: true },
    { name: "python -m pip", lookup: true },
  ],
  pip3: [
    { name: "pip", lookup: true },
    { name: "python -m pip", lookup: true },
  ],
  rg: [
    { name: "grep -rn", lookup: true, only: "posix" },
    { name: "Select-String", lookup: false, only: "powershell" },
  ],
  grep: [
    { name: "rg", lookup: true },
    { name: "Select-String", lookup: false, only: "powershell" },
    { name: "findstr", lookup: true, only: "cmd" },
  ],
  fd: [
    { name: "find", lookup: true, only: "posix" },
    { name: "Get-ChildItem -Recurse", lookup: false, only: "powershell" },
  ],
  find: [
    { name: "fd", lookup: true },
    { name: "Get-ChildItem -Recurse", lookup: false, only: "powershell" },
  ],
  which: [
    { name: "command -v", lookup: false, only: "posix" },
    { name: "Get-Command", lookup: false, only: "powershell" },
    { name: "where", lookup: false, only: "cmd" },
  ],
  head: [{ name: "Select-Object -First N", lookup: false, only: "powershell" }],
  tail: [{ name: "Get-Content -Tail N", lookup: false, only: "powershell" }],
  touch: [
    { name: "New-Item -ItemType File", lookup: false, only: "powershell" },
  ],
  ls: [{ name: "dir", lookup: false, only: "cmd" }],
  cat: [{ name: "type", lookup: false, only: "cmd" }],
  rm: [{ name: "del", lookup: false, only: "cmd" }],
  cp: [{ name: "copy", lookup: false, only: "cmd" }],
  mv: [{ name: "move", lookup: false, only: "cmd" }],
  curl: [{ name: "wget", lookup: true }],
  wget: [{ name: "curl", lookup: true }],
};

function family(shell: ShellKind): "posix" | "powershell" | "cmd" | undefined {
  return isPosixShell(shell)
    ? "posix"
    : shell === "powershell" || shell === "cmd"
      ? shell
      : undefined;
}

/** Up to three alternatives that are present in this shell. */
export function alternativesFor(
  program: string,
  ctx: Pick<MissingBinaryContext, "shell" | "hasProgram">,
): string[] {
  const fam = family(ctx.shell);
  const out: string[] = [];
  for (const alt of ALTERNATIVES[program] ?? []) {
    if (alt.only && alt.only !== fam) continue;
    if (alt.lookup && !ctx.hasProgram(alt.name.split(" ")[0])) continue;
    out.push(alt.name);
    if (out.length === 3) break;
  }
  return out;
}

/** The install command for the program on this platform, as text; never run. */
export function installHint(
  program: string,
  platform: NodeJS.Platform,
  hasProgram: (name: string) => boolean,
): string | undefined {
  const entry = INSTALL_HINTS[program];
  if (!entry) return undefined;
  if (platform === "win32") {
    return entry.winget ? `winget install ${entry.winget}` : undefined;
  }
  if (platform === "darwin") return entry.brew && `brew install ${entry.brew}`;
  if (platform !== "linux") return undefined;
  if (entry.apt && hasProgram("apt-get"))
    return `sudo apt install ${entry.apt}`;
  if (entry.dnf && hasProgram("dnf")) return `sudo dnf install ${entry.dnf}`;
  if (entry.pacman && hasProgram("pacman")) {
    return `sudo pacman -S ${entry.pacman}`;
  }
  return undefined;
}

export interface MissingBinaryMessageOptions extends MissingBinaryContext {
  /** Where commands run, in the executor's words */
  where: string;
  /** The platform the command runs on (a WSL command is linux's) */
  platform: NodeJS.Platform;
}

/** What the agent receives in place of a command that cannot run. */
export function missingBinaryMessage(
  problem: MissingBinaryProblem,
  opts: MissingBinaryMessageOptions,
): string {
  const { program } = problem;
  const lines = [
    `Command not run: \`${program}\` was not found (looked in: ${opts.where}).`,
  ];
  const alternatives = alternativesFor(program, opts);
  if (alternatives.length) {
    lines.push(`Present here instead: ${alternatives.join(", ")}.`);
  }
  const hint = installHint(program, opts.platform, opts.hasProgram);
  if (hint) lines.push(`To install it (this tool does not run it): ${hint}`);
  lines.push(
    "The command was not run, so nothing in it took effect. Use another program, or ask the person to install this one.",
  );
  return lines.join("\n");
}
