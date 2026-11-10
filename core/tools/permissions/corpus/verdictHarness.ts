import type { ShellKind } from "../../../util/shell";
import { commandCandidates } from "../candidates";
import { protectedCommandHit } from "../protectedCall";
import { classifyReadOnly } from "../readOnlyCommand";
import { type VerdictCase } from "./verdicts";

/** A machine with no git repository and a git config that runs nothing. */
const HOME = "C:\\Users\\me";
const GIT_CLEAN = {
  cwd: "/repo",
  home: "/home/u",
  readGitConfig: () => "",
  probe: () => undefined,
};

export interface Scan {
  /** The read-only classifier vouched for the command */
  vouched: boolean;
  /** What the protected-path scan found, or "none" */
  protectsFound: string;
  /** Whether some candidate a text rule is tried against names the resolved program */
  resolvesOk: boolean | undefined;
}

/** True when a candidate string begins with the program and subcommand, ignoring case. */
function candidateNames(
  command: string,
  resolves: string,
  shell: ShellKind,
): boolean {
  const want = resolves.toLowerCase();
  return commandCandidates(command, shell).some((c) => {
    const got = c.trim().toLowerCase();
    return got === want || got.startsWith(want + " ");
  });
}

export function scan(kase: VerdictCase, shell: ShellKind): Scan {
  const vouched = classifyReadOnly(kase.command, {
    shell,
    ...GIT_CLEAN,
  }).vouched;
  const hit = protectedCommandHit(kase.command, HOME, [], undefined, shell);
  return {
    vouched,
    protectsFound: hit ? hit.kind : "none",
    resolvesOk: kase.resolves
      ? candidateNames(kase.command, kase.resolves, shell)
      : undefined,
  };
}

/** A stable key for a case in a shell, for lists of known gaps. */
export const keyOf = (shell: ShellKind, kase: VerdictCase) =>
  `${shell} | ${kase.command}`;
