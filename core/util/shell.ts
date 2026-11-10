/**
 * Which shell runs a terminal command, in one place. The runners, the command
 * classifiers and the permission engine all need the same answer: a command
 * means what its shell makes of it, and `date 1-1-20`, `find`, `sort` and a
 * backtick are not the same thing in bash, PowerShell and cmd
 * (plans/command-analysis.md).
 */
export type ShellKind =
  /** bash, and any shell that starts as one */
  | "bash"
  | "zsh"
  /** sh, dash, ash: the POSIX subset */
  | "sh"
  /** Windows PowerShell 5.1 and PowerShell 7+ */
  | "powershell"
  | "cmd"
  /** fish, nushell, ksh, tcsh, or anything not recognised: never vouched */
  | "unknown";

/** Shells whose grammar is POSIX's (bash and zsh add to it). */
export const POSIX_SHELLS: readonly ShellKind[] = ["bash", "zsh", "sh"];

export function isPosixShell(kind: ShellKind | undefined): boolean {
  return !!kind && POSIX_SHELLS.includes(kind);
}

/** The kind of shell an executable is, from its name alone. */
export function shellKindOf(executable: string | undefined): ShellKind {
  const name = (executable ?? "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  switch (name) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
    case "dash":
    case "ash":
      return "sh";
    case "powershell":
    case "pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return "unknown";
  }
}

export interface ResolvedShell {
  kind: ShellKind;
  executable: string;
  /** The arguments that make the shell run `command` and exit */
  args: (command: string) => string[];
  /** Start-up files run before the command, so the person's own code does */
  runsProfile: boolean;
}

export interface ShellEnvironment {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Overrides the process-wide preference and `CONTINUOUS_TERMINAL_SHELL` */
  terminalShell?: TerminalShellPreference | "default";
}

/**
 * Where the person asked terminal commands to run instead of the host's own
 * shell. Only WSL is offered: on Windows, commands run in a WSL distribution
 * through `wsl.exe` (plans/isolation.md, W1).
 */
export interface TerminalShellPreference {
  kind: "wsl";
  /** The distribution (`wsl -l`); the default distribution when absent */
  distro?: string;
}

/**
 * `wsl` or `wsl:<distribution>` (also `wsl/<distribution>`), as written in
 * the `CONTINUOUS_TERMINAL_SHELL` environment variable. Anything else,
 * including `default`, is no preference.
 */
export function parseTerminalShell(
  value: string | undefined,
): TerminalShellPreference | undefined {
  const m = /^wsl(?:[:/](.+))?$/i.exec((value ?? "").trim());
  if (!m) return undefined;
  const distro = m[1]?.trim();
  return distro ? { kind: "wsl", distro } : { kind: "wsl" };
}

let configuredShell: TerminalShellPreference | undefined;

/** Set by the editor from its settings; `undefined` goes back to the default. */
export function setTerminalShellPreference(
  preference: TerminalShellPreference | undefined,
): void {
  configuredShell = preference;
}

export function getTerminalShellPreference(
  env: Record<string, string | undefined> = process.env,
): TerminalShellPreference | undefined {
  return configuredShell ?? parseTerminalShell(env.CONTINUOUS_TERMINAL_SHELL);
}

/**
 * The arguments that make `wsl.exe` run `command` in bash exactly as written.
 * The command is sent as base64 and sourced from a process substitution:
 * `wsl.exe` re-parses its command line, which was seen to drop the quotes
 * from `<<'EOF'` (so `$HOME` expanded inside a quoted heredoc), while base64
 * has no characters to mangle. Sourcing keeps the command in the login shell
 * itself, so `exit N`, `cd` and standard input behave as they do for
 * `bash -c`. A Windows command line holds about 32,000 characters, so a very
 * long command (over about 24,000 before encoding) fails to start.
 */
export function wslArgs(command: string, distro?: string): string[] {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return [
    ...(distro ? ["-d", distro] : []),
    "--",
    "bash",
    "-lc",
    `source <(echo ${encoded} | base64 -d)`,
  ];
}

/**
 * The shell terminal commands run in: Windows PowerShell on Windows, the
 * person's login shell elsewhere (bash when `$SHELL` is not set). WSL is a
 * Linux, so it takes the second branch. On Windows a preference for WSL
 * (`terminalShell`, the editor's setting, or `CONTINUOUS_TERMINAL_SHELL`) runs
 * commands in bash inside that distribution instead.
 */
export function resolveShell(opts: ShellEnvironment = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const preference =
    opts.terminalShell === "default"
      ? undefined
      : (opts.terminalShell ?? getTerminalShellPreference(env));
  if (platform === "win32" && preference?.kind === "wsl") {
    // The command is bash's, whatever the host is: the classifiers, the
    // lint and the policy engine read it with bash's grammar
    return {
      kind: "bash",
      executable: "wsl.exe",
      args: (command) => wslArgs(command, preference.distro),
      runsProfile: true,
    };
  }
  if (platform === "win32") {
    return {
      kind: "powershell",
      executable: "powershell.exe",
      args: (command) => [
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      // No -NoProfile: the person's profile runs first
      runsProfile: true,
    };
  }
  const executable = env.SHELL || "/bin/bash";
  return {
    kind: shellKindOf(executable),
    executable,
    args: (command) => ["-l", "-c", command],
    runsProfile: true,
  };
}
