import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import {
  resolveShell,
  type ResolvedShell,
  type ShellEnvironment,
} from "./shell";

/**
 * Where and how a terminal command runs, in one place (plans/isolation.md,
 * W0). The IDE's and the CLI's terminal tools ask for an executor instead of
 * choosing a shell themselves, so a new place to run commands (a container, a
 * dev container, an OS sandbox) is a new executor and not a change to every
 * tool.
 *
 * Today there are two: the machine's own shell, and bash inside a WSL
 * distribution (`CONTINUOUS_TERMINAL_SHELL` and the editor's setting). The
 * interface is small on purpose: what the command analysis needs to read the
 * command (the shell), how to start it, and a sentence saying where it runs.
 */
export interface CommandExecutor {
  kind: "local" | "wsl";
  /**
   * The shell that parses the command. The command lint, the classifiers and
   * the policy engine read it with this shell's grammar, whatever the host is.
   */
  shell: ResolvedShell;
  /** The program and arguments that run `command` and exit. */
  invocation(command: string): { shell: string; args: string[] };
  /** Starts `command`. Options are those of `child_process.spawn`. */
  spawn(command: string, options?: SpawnOptions): ChildProcess;
  /** One sentence saying where commands run, for a status line or a tool description. */
  describe(): string;
}

/** The executor for the current settings, or for `opts` when given. */
export function getCommandExecutor(
  opts: ShellEnvironment = {},
): CommandExecutor {
  const shell = resolveShell(opts);
  const wsl = shell.executable.toLowerCase().endsWith("wsl.exe");
  return {
    kind: wsl ? "wsl" : "local",
    shell,
    invocation: (command) => ({
      shell: shell.executable,
      args: shell.args(command),
    }),
    spawn: (command, options) =>
      spawn(shell.executable, shell.args(command), options ?? {}),
    describe: () =>
      wsl
        ? "bash inside WSL, started from the workspace folder"
        : `${shell.kind} on this machine`,
  };
}
