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
}

/**
 * The shell terminal commands run in: Windows PowerShell on Windows, the
 * person's login shell elsewhere (bash when `$SHELL` is not set). WSL is a
 * Linux, so it takes the second branch.
 */
export function resolveShell(opts: ShellEnvironment = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
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
