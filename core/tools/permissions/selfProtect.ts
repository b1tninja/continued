import * as os from "node:os";
import type { ShellKind } from "../../util/shell";
import { commandCandidateSet } from "./candidates";
import { normalizeProtectedPath } from "./protected";
import { pathWords, wordsOf } from "./protectedCall";
import { classifyReadOnly } from "./readOnlyCommand";

/**
 * The permission and policy files protect themselves. A call that would write
 * or delete one is a locked floor: no setting, rule or level lets it run
 * unasked, YOLO included, because a model that can edit the policy can undo
 * every other protection. `protect-config` is a separate, switchable rule over
 * the wider set of files that change what runs later; this one has no switch.
 *
 * What counts as a policy file (home-relative `~/.continue` and
 * `~/.continuous`, or a project directory of that name, at any depth):
 * any yaml/json file inside (config.yaml, permissions.yaml, rule and block
 * files), `mcp-tool-pins.json`, the `rules` and `audit` directories, and the
 * directory itself (deleting it deletes them all); plus `.continuerc.*` and
 * `.continuousrc.*` anywhere.
 *
 * Like protected paths this reads the path as written and resolved, and a
 * terminal command by its words: it is a guard that sees what is visible, not
 * a sandbox. A path built at run time (a variable, a glob) is not seen.
 */
export interface PolicyFileHit {
  /** The path as it was matched, for the message. */
  path: string;
}

export const POLICY_FILE_REASON =
  "This would change your permission or policy files, which no setting lets the agent change without you.";

const POLICY_DIRS = new Set([".continue", ".continuous"]);
const POLICY_SUBTREES = new Set(["rules", "audit"]);
const POLICY_EXT = /\.(ya?ml|json)$/i;
const RC_FILE = /^\.(continue|continuous)rc(\..+)?$/;

/** A normalized (forward-slash, lower-cased on compare) path of a policy file. */
export function isPolicyFilePath(p: string): boolean {
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  const low = segs.map((s) => s.toLowerCase());
  if (RC_FILE.test(low[low.length - 1] ?? "")) return true;
  const i = low.findIndex((s) => POLICY_DIRS.has(s));
  if (i < 0) return false;
  const rest = low.slice(i + 1);
  if (rest.length === 0) return true;
  if (POLICY_SUBTREES.has(rest[0])) return true;
  const base = rest[rest.length - 1];
  return base === "mcp-tool-pins.json" || POLICY_EXT.test(base);
}

function policyPathHit(
  raw: string | undefined,
  home: string,
  cwd?: string,
): PolicyFileHit | undefined {
  if (!raw) return undefined;
  const path = normalizeProtectedPath(raw, home, cwd);
  return path && isPolicyFilePath(path) ? { path } : undefined;
}

const WRITE_TOOLS = new Set([
  "create_new_file",
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
]);

/** git subcommands that only read the index or history, or stage and commit. */
const GIT_NOT_WRITING = new Set([
  "add",
  "commit",
  "diff",
  "log",
  "show",
  "status",
  "blame",
  "ls-files",
  "check-ignore",
  "grep",
]);

function terminalHit(
  command: string,
  home: string,
  cwd: string | undefined,
  shell: ShellKind | undefined,
): PolicyFileHit | undefined {
  // A command the parser vouched as only reading cannot write.
  if (classifyReadOnly(command, { cwd, shell }).vouched) return undefined;
  const { list } = commandCandidateSet(command, shell);
  const reading = new Set(
    wordsOf(list).flatMap((w, i) =>
      w[0] === "git" && GIT_NOT_WRITING.has(w[1] ?? "") ? [list[i]] : [],
    ),
  );
  // Candidates derived from a git command that only stages or reads (the
  // command without `git`, its path argument alone) are not writes either.
  const considered = list.filter(
    (c) => ![...reading].some((r) => r.includes(c)),
  );
  for (const word of pathWords(considered)) {
    const hit = policyPathHit(word, home, cwd);
    if (hit) return hit;
  }
  return undefined;
}

/** Every string in an MCP call's arguments, two levels deep. */
function stringArgs(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 2 || !value || typeof value !== "object") return [];
  return Object.values(value).flatMap((v) => stringArgs(v, depth + 1));
}

/**
 * Would this call write or delete a policy file? `mcp` is set for an MCP
 * tool, with its `readonly` hint: a tool that says it only reads is skipped,
 * any other MCP call naming such a path in its arguments is a hit.
 */
export function policyFileHit(args: {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  resolvedPath?: string;
  mcp?: { readonly?: boolean };
  home?: string;
  cwd?: string;
  shell?: ShellKind;
}): PolicyFileHit | undefined {
  const { toolName, parsedArgs, resolvedPath, cwd } = args;
  const home = args.home ?? os.homedir();
  if (toolName === "run_terminal_command") {
    const command = parsedArgs.command;
    return typeof command === "string"
      ? terminalHit(command, home, cwd, args.shell)
      : undefined;
  }
  if (args.mcp) {
    if (args.mcp.readonly) return undefined;
    for (const value of stringArgs(parsedArgs)) {
      const hit = policyPathHit(value, home, cwd);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  const written =
    typeof parsedArgs.filepath === "string" ? parsedArgs.filepath : undefined;
  return (
    policyPathHit(written, home, cwd) ?? policyPathHit(resolvedPath, home, cwd)
  );
}
