import * as nodePath from "node:path";
import { BuiltInToolNames } from "../../builtIn";
import { commandCandidateSet } from "../candidates";
import { programName } from "../destinations";
import type { ShellKind } from "../../../util/shell";
import type { TaintKind } from "./taintState";

/**
 * What counts as untrusted content entering the conversation, judged from the
 * call that fetched it (never from the content). plans/design/tainted-session.md.
 */
export interface SourceCall {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** An MCP tool: its output is the server's, whoever runs the server */
  mcp?: boolean;
  /** Workspace folders as paths; the first is the folder commands and relative paths start in */
  workspaceDirs?: readonly string[];
  shell?: ShellKind;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const WIN_PATH = /^[a-zA-Z]:[\\/]|^\\\\/;

function flavorOf(p: string): typeof nodePath.posix {
  return WIN_PATH.test(p) ? nodePath.win32 : nodePath.posix;
}

/**
 * Whether a path, as written, lies outside every workspace folder. Links are
 * not followed here: the policy-time check does that, this one only has to be
 * cheap and to err toward "outside" (a spurious taint costs a few asks).
 */
export function isOutsideWorkspace(
  raw: string,
  dirs: readonly string[] | undefined,
): boolean {
  if (!dirs?.length) return false;
  const text = raw.trim();
  if (text.startsWith("~")) return true;
  const flavor = flavorOf(text);
  const fold = (p: string) => (flavor === nodePath.win32 ? p.toLowerCase() : p);
  const base = dirs[0];
  // A file URI's path on Windows is `/c:/dir`; the drive form is what a path is written as
  const plain = (d: string) => d.replace(/^\/([a-zA-Z]:)/, "$1");
  const abs = flavor.isAbsolute(text)
    ? flavor.normalize(text)
    : flavor.resolve(plain(base), text);
  return !dirs.some((d) => {
    const dir = flavor.normalize(plain(d));
    const rel = flavor.relative(fold(dir), fold(abs));
    return rel === "" || (!rel.startsWith("..") && !flavor.isAbsolute(rel));
  });
}

const FILE_READS: Record<string, string> = {
  [BuiltInToolNames.ReadFile]: "filepath",
  [BuiltInToolNames.ReadFileRange]: "filepath",
  [BuiltInToolNames.CodeNavigation]: "filepath",
  [BuiltInToolNames.LSTool]: "dirPath",
  [BuiltInToolNames.ViewSubdirectory]: "directory_path",
};

/** A tool that reads a file or a folder, which taints when its target is outside the workspace. */
export function isFileReadTool(toolName: string): boolean {
  return toolName in FILE_READS;
}

/** Programs whose output is text somebody else wrote: a web page or an issue. */
const WEB_PROGRAMS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "invoke-webrequest",
  "invoke-restmethod",
]);
const ISSUE_VERBS = new Set(["view", "list", "diff", "checks", "status"]);
const ISSUE_NOUNS = new Set(["issue", "pr", "release", "gist", "run"]);

function commandSource(command: string, shell?: ShellKind) {
  for (const c of commandCandidateSet(command, shell).list) {
    const words = c.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const program = programName(words[0]);
    if (WEB_PROGRAMS.has(program)) return "web-fetch" as const;
    if (program === "gh") {
      const rest = words.slice(1).filter((w) => !w.startsWith("-"));
      if (rest[0] === "api") return "issue-text" as const;
      if (ISSUE_NOUNS.has(rest[0]) && ISSUE_VERBS.has(rest[1])) {
        return "issue-text" as const;
      }
    }
  }
  return undefined;
}

/** The kind of untrusted content this call brought into the conversation, if any. */
export function taintKindOfCall(call: SourceCall): TaintKind | undefined {
  const { toolName, parsedArgs } = call;
  if (call.mcp) return "mcp-result";
  if (
    toolName === BuiltInToolNames.FetchUrlContent ||
    toolName === BuiltInToolNames.SearchWeb
  ) {
    return "web-fetch";
  }
  const pathArg = FILE_READS[toolName];
  if (pathArg) {
    const raw = str(parsedArgs[pathArg]) ?? (pathArg === "dirPath" ? "." : "");
    return raw && isOutsideWorkspace(raw, call.workspaceDirs)
      ? "outside-read"
      : undefined;
  }
  if (toolName === BuiltInToolNames.RunTerminalCommand) {
    const command = str(parsedArgs.command);
    return command ? commandSource(command, call.shell) : undefined;
  }
  return undefined;
}
