import type { CommandGraph } from "./shellScan";

/**
 * A second reader for POSIX commands, if one is available. The strict scanner
 * says what a command is; the cross-check says whether the bash grammar sees
 * the same thing. If they differ, the command is not understood: a scanner
 * that reads a command differently from the shell is how an escaped quote
 * once hid a second command. The reader is registered at start-up by whoever
 * can load a grammar (core, in the IDE); without one nothing changes.
 *
 * It lives apart from treeSitterBash.ts so that the classifier does not
 * import the parser, which a bundle such as the CLI's may not carry.
 */
export type BashCrossCheck = (
  command: string,
  ours: CommandGraph,
) => string | undefined;

let registered: BashCrossCheck | undefined;

export function setBashCrossCheck(check: BashCrossCheck | undefined): void {
  registered = check;
}

export function bashCrossCheckReady(): boolean {
  return registered !== undefined;
}

/** Why the second reader disagrees, or undefined when it agrees or is absent. */
export function runBashCrossCheck(
  command: string,
  ours: CommandGraph,
): string | undefined {
  return registered?.(command, ours);
}
