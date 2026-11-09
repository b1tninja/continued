import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShellKind } from "../../util/shell";
import { canonicalCmdlet, checkReadCmdlet } from "./powershell";
import { scanCommand } from "./shellScan";

/**
 * Is this command certain to only read? (plans/policy-areas.md, "Which area a
 * call belongs to".) A read-only command is Context use, the same as a
 * read-only tool, so `git log` is decided by the Context level and not by Tool
 * use.
 *
 * Two outcomes, and a claim that travels with the call: vouched, or not, and
 * why not. Being unsure counts against running, so the parser accepts only
 * what it fully understands: words and quoted strings, the operators
 * `| && || ;`, and the redirects to nowhere (`2>/dev/null`, `>/dev/null`,
 * `2>&1`). Substitution, other redirects, variables, groups, background jobs,
 * environment prefixes, UNC paths, and anything over 10,000 characters are
 * not vouched. Every part must then be on the list below with its arguments
 * checked. `awk`, interpreters, `xargs`, `eval` and `source` are never on it,
 * and nothing that contacts the network is.
 */
export type ReadOnlyClaim =
  | { vouched: true; judge: "parser"; claim: string }
  | { vouched: false; judge: "parser"; why: string };

export const MAX_READ_ONLY_COMMAND_LENGTH = 10_000;

const no = (why: string): ReadOnlyClaim => ({
  vouched: false,
  judge: "parser",
  why,
});

type Check = (args: string[]) => string | undefined;

const anyArgs: Check = () => undefined;
const reject =
  (...flags: string[]): Check =>
  (args) => {
    for (const a of args) {
      const flag = a.split("=")[0];
      if (flags.includes(flag)) return `argument ${flag} is not recognised`;
    }
    return undefined;
  };

/** Commands that only read, by lower-cased name, and what to check in their arguments. */
const READ_ONLY: Record<string, Check> = {
  // files and directories
  ls: anyArgs,
  dir: anyArgs,
  cat: anyArgs,
  head: anyArgs,
  tail: reject("-f", "-F", "--follow"),
  wc: anyArgs,
  stat: anyArgs,
  du: anyArgs,
  df: anyArgs,
  tree: reject("-o"),
  pwd: anyArgs,
  realpath: anyArgs,
  readlink: anyArgs,
  basename: anyArgs,
  dirname: anyArgs,
  which: anyArgs,
  file: reject("-m", "-f", "-C", "--magic-file", "--files-from", "--compile"),
  md5sum: anyArgs,
  sha1sum: anyArgs,
  sha256sum: anyArgs,
  // text
  echo: anyArgs,
  grep: anyArgs,
  egrep: anyArgs,
  fgrep: anyArgs,
  rg: reject("--pre", "--hostname-bin"),
  find: reject(
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ),
  sort: reject("-o", "--output", "--compress-program"),
  uniq: (args) =>
    args.filter((a) => !a.startsWith("-")).length > 1
      ? "a second file would be written to"
      : undefined,
  cut: anyArgs,
  tr: anyArgs,
  nl: anyArgs,
  tac: anyArgs,
  rev: anyArgs,
  column: anyArgs,
  comm: anyArgs,
  cmp: anyArgs,
  diff: reject("--output"),
  jq: reject("-f", "--from-file"),
  sed: (args) => {
    // Only `sed -n 'N,Mp'` (print a range), the one form that cannot write
    const [flag, script, ...files] = args;
    if (flag !== "-n" || script === undefined) {
      return "sed is read-only only as -n with a print range";
    }
    if (!/^(\d+(,\d+)?|\$)p$/.test(script)) {
      return "the sed script is not a plain print range";
    }
    return files.some((f) => f.startsWith("-"))
      ? "extra sed flags are not recognised"
      : undefined;
  },
  // the machine
  date: reject("-s", "--set"),
  whoami: anyArgs,
  id: anyArgs,
  uname: anyArgs,
  hostname: (args) =>
    args.length ? "hostname with arguments can set it" : undefined,
  // moving around changes nothing on disk
  cd: (args) => (args.length > 1 ? "cd with several arguments" : undefined),
};

/**
 * Programs PowerShell runs the same way every shell does. Its own cmdlets and
 * their aliases are not a list of names here: they go through powershell.ts,
 * which knows each cmdlet's parameters. Names that are other programs on
 * Windows (`find`, `date`) are not here, so they are not vouched.
 */
const POWERSHELL_EXTERNAL: Record<string, Check> = {
  rg: READ_ONLY.rg,
  jq: READ_ONLY.jq,
  grep: READ_ONLY.grep,
  whoami: anyArgs,
  hostname: READ_ONLY.hostname,
  tree: READ_ONLY.tree,
};

/** Names that move the working directory, after which git's config was not checked. */
const CHANGES_DIRECTORY = new Set(["cd", "set-location"]);

/** git subcommands that read, with the extra arguments each may take. */
const GIT_READ: Record<string, Check> = {
  status: anyArgs,
  log: reject("--output", "-O"),
  diff: reject("--output", "-O", "--ext-diff", "--no-index"),
  show: reject("--output", "--ext-diff"),
  blame: anyArgs,
  "rev-parse": anyArgs,
  "rev-list": anyArgs,
  "ls-files": anyArgs,
  "ls-tree": anyArgs,
  "cat-file": (args) =>
    args.some((a) => a.startsWith("--batch") || a.startsWith("--textconv"))
      ? "cat-file batch and textconv modes are not recognised"
      : undefined,
  describe: anyArgs,
  shortlog: anyArgs,
  "merge-base": anyArgs,
  "name-rev": anyArgs,
  "for-each-ref": anyArgs,
  "diff-tree": reject("--output"),
  grep: reject("--open-files-in-pager", "-O"),
  branch: (args) =>
    args.length === 0 ||
    args.every((a) =>
      [
        "-a",
        "-r",
        "-v",
        "-vv",
        "--list",
        "-l",
        "--show-current",
        "--all",
        "--remotes",
      ].includes(a),
    )
      ? undefined
      : "branch with other arguments can create or delete",
  tag: (args) =>
    args.length === 0 || args.every((a) => ["-l", "--list", "-n"].includes(a))
      ? undefined
      : "tag with other arguments can create or delete",
  remote: (args) =>
    args.length === 0 ||
    (args.length === 1 && ["-v", "--verbose"].includes(args[0]))
      ? undefined
      : "remote with other arguments can change or contact one",
  stash: (args) =>
    args[0] === "list" || args[0] === "show"
      ? undefined
      : "only stash list and stash show only read",
};

/** The global flags git accepts before its subcommand without running anything. */
const GIT_SAFE_GLOBAL = new Set(["--no-pager", "--no-optional-locks", "-P"]);

/** Config keys under which git can be made to run a program. */
const GIT_RUNS_THINGS =
  /^\s*(fsmonitor|hookspath|sshcommand|textconv|external|askpass|editor|gpg\.program|program)\s*=|^\s*\[\s*(include|includeif|hook|filter)\b/im;

export interface ReadOnlyOptions {
  /**
   * The shell that will run the command (resolveShell). A command means what
   * its shell makes of it, so without a shell we understand, nothing is vouched.
   */
  shell?: ShellKind;
  /** The folder the command runs in, to read the repository's git config */
  cwd?: string;
  /** For tests: the text of a git config file, or undefined when absent */
  readGitConfig?: (file: string) => string | undefined;
  /** For tests: what a path is, "dir" or "file", or undefined when absent */
  probe?: (file: string) => "dir" | "file" | undefined;
  home?: string;
}

function defaultProbe(file: string): "dir" | "file" | undefined {
  try {
    return fs.statSync(file).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function defaultReadGitConfig(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * `git status`, `git diff` and the like run `core.fsmonitor`, hooks and
 * filters from the repository's own config: this was exploited across seven
 * agents in 2026. So git is vouched only when neither the repository's config
 * nor the user's names such a thing, and not at all without a folder to look
 * in.
 */
function gitIsSafe(opts: ReadOnlyOptions): string | undefined {
  if (!opts.cwd)
    return "git is not vouched without a folder to check its config in";
  const read = opts.readGitConfig ?? defaultReadGitConfig;
  const home = opts.home ?? os.homedir();
  // A file URI's path is "/C:/..." on Windows, which fs does not take
  const cwd = opts.cwd.replace(/^\/([A-Za-z]:)/, "$1");
  const probe = opts.probe ?? defaultProbe;
  // The repository is the nearest folder up the tree with a .git: the
  // workspace is often a subfolder of it
  const files = [
    path.join(home, ".gitconfig"),
    path.join(home, ".config", "git", "config"),
  ];
  for (let dir = cwd; ;) {
    const kind = probe(path.join(dir, ".git"));
    if (kind === "file") {
      // A worktree or submodule: its config is somewhere this does not look
      return `${dir} is a git worktree or submodule, whose config was not checked`;
    }
    if (kind === "dir") {
      files.unshift(path.join(dir, ".git", "config"));
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const file of files) {
    const text = read(file);
    if (text && GIT_RUNS_THINGS.test(text)) {
      return `git config (${file}) can run programs (fsmonitor, hooks, filters or similar)`;
    }
  }
  return undefined;
}

/**
 * cmd's own commands: cmd runs these itself, before it looks for a file of
 * that name, so they are the same everywhere. Every other name in cmd is a
 * program, and cmd searches the current directory for programs first, so any
 * of them can be a file in the repository: not vouched.
 */
const CMD_DIR_SWITCH = /^\/(-?[abcdlnopqrstwx4?]|[aot]:[a-z-]+)$/i;
const CMD_INTERNAL: Record<string, Check> = {
  dir: (args) =>
    args.every((a) => !a.startsWith("/") || CMD_DIR_SWITCH.test(a))
      ? undefined
      : "dir with a switch that is not recognised",
  type: (args) =>
    args.some((a) => a.startsWith("/")) ? "type takes no switches" : undefined,
  cd: (args) =>
    args.length === 0 ||
    args.length === 1 ||
    (args.length === 2 && args[0].toLowerCase() === "/d")
      ? undefined
      : "cd with several arguments",
  echo: anyArgs,
  ver: (args) => (args.length ? "ver takes no arguments" : undefined),
  vol: (args) => (args.length > 1 ? "vol with several arguments" : undefined),
  path: (args) => (args.length ? "path with an argument sets it" : undefined),
  // Listing the variables only: one name prints those that start with it
  set: (args) =>
    args.length > 1 || args.some((a) => a.startsWith("/"))
      ? "set with a switch or several arguments"
      : undefined,
};
CMD_INTERNAL.chdir = CMD_INTERNAL.cd;

/** Does this command only read? See the file comment for what that takes. */
export function classifyReadOnly(
  command: string,
  opts: ReadOnlyOptions = {},
): ReadOnlyClaim {
  if (typeof command !== "string" || !command.trim()) return no("no command");
  if (command.length > MAX_READ_ONLY_COMMAND_LENGTH) {
    return no(`the command is over ${MAX_READ_ONLY_COMMAND_LENGTH} characters`);
  }
  const shell = opts.shell;
  if (!shell) return no("the shell that runs it is not known");
  if (shell === "unknown") return no("this shell is not parsed");
  // UNC paths reach another computer
  if (/(^|[\s'"])(\\\\|\/\/)[^\s\\/]+[\\/]/.test(command)) {
    return no("a network path (UNC) is named");
  }
  const scanned = scanCommand(command, shell);
  if (!scanned.ok) return no(scanned.why);

  const names: string[] = [];
  // After a cd the command runs somewhere whose git config was not checked
  let movedDirectory = false;
  for (const { words } of scanned.graph.commands) {
    const [first, ...rest] = words;
    // An environment prefix (FOO=bar cmd) can change what a command does
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      return no("an environment prefix");
    }
    const name = first.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      return no(`"${first}" is not a plain command name`);
    }
    if (shell === "cmd") {
      const check = CMD_INTERNAL[name];
      if (!check) {
        return no(
          `${name} is not one of cmd's own commands, so it may be a file`,
        );
      }
      const problem = check(rest);
      if (problem) return no(`${name}: ${problem}`);
      names.push(name);
      continue;
    }
    if (CHANGES_DIRECTORY.has(name)) movedDirectory = true;
    if (name === "git") {
      if (movedDirectory) {
        return no(
          "git after cd runs in a folder whose git config was not checked",
        );
      }
      const unsafe = gitIsSafe(opts);
      if (unsafe) return no(unsafe);
      // Global flags before the subcommand: only the ones that run nothing
      let i = 0;
      while (i < rest.length && rest[i].startsWith("-")) {
        if (!GIT_SAFE_GLOBAL.has(rest[i])) {
          return no(
            `git flag ${rest[i]} before the subcommand is not recognised`,
          );
        }
        i++;
      }
      const sub = rest[i];
      const check = sub ? GIT_READ[sub] : undefined;
      if (!check)
        return no(
          `git ${sub ?? ""} is not on the read-only list`.replace("  ", " "),
        );
      const problem = check(rest.slice(i + 1));
      if (problem) return no(`git ${sub}: ${problem}`);
      names.push(`git ${sub}`);
      continue;
    }
    if (shell === "powershell" && !(name in POWERSHELL_EXTERNAL)) {
      // A cmdlet or an alias of one: known by its parameters, not its name
      const cmdlet = canonicalCmdlet(name);
      if (cmdlet) {
        if (CHANGES_DIRECTORY.has(cmdlet)) movedDirectory = true;
        const problem = checkReadCmdlet(cmdlet, rest);
        if (problem) return no(problem);
        names.push(cmdlet);
        continue;
      }
    }
    const list = shell === "powershell" ? POWERSHELL_EXTERNAL : READ_ONLY;
    const check = list[name];
    if (!check) {
      return no(
        `${name} is not on the ${shell === "powershell" ? "PowerShell " : ""}read-only list`,
      );
    }
    const problem = check(rest);
    if (problem) return no(`${name}: ${problem}`);
    names.push(name);
  }
  return {
    vouched: true,
    judge: "parser",
    claim: `only reads: ${[...new Set(names)].join(", ")}`,
  };
}
