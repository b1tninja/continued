import { isSecretName } from "../../util/secretScan/secretNames";
import { looksSecret } from "./secretCommands";

/**
 * Which environment variable names change what a command does, for the
 * assignment prefix (`NAME=value cmd`, `env NAME=value cmd`, `$env:NAME = ...`,
 * `set NAME=value`). A rule is written about a program and its arguments
 * (`git status`, `npm test`), and the same text means something else when the
 * variable in front of it makes git run another program, makes node load a
 * file, or points a tool at another server. So the name decides.
 *
 *   dangerous  loads code, runs a program, or changes which program a name
 *              means: asks at every level, YOLO included (like a command whose
 *              name is a variable)
 *   sensitive  redirects configuration, credentials, network or where files
 *              go: asks below YOLO, like a protected path
 *   harmless   reviewed as inert (colour, locale, log level): never asks
 *   unknown    nothing says it matters: no extra ask. The command is still
 *              never read as read-only (readOnlyCommand.ts), and every rule
 *              still sees the program after the assignments
 *
 * Names are compared ignoring case: Windows variables are not case
 * sensitive, and matching more is the safe direction. The lists are built in.
 * `EnvNameOptions` lets a caller add names (`ask`) or take names off
 * (`allow`); the caller must read them from the person's own config and from
 * nothing else (not a workspace file, an assistant or the environment).
 * Nothing feeds it yet (ROADMAP follow-up), so today only the built-in lists
 * apply.
 *
 * Sources, one per family. The git, Node.js and ld.so pages were re-read on
 * 2026-11-11 (GIT_CONFIG_COUNT and GIT_EXEC_PATH were not visible in the page
 * text fetched); the others are listed from the named documents and not
 * re-read:
 *   ld.so(8) and the dynamic linker: LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT
 *     https://man7.org/linux/man-pages/man8/ld.so.8.html
 *   dyld(1) on macOS: DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH and the rest
 *     https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/DynamicLibraries/
 *   Bash manual, "Bash Variables" and "Bash Startup Files": BASH_ENV, ENV,
 *     PROMPT_COMMAND, PS4, IFS, SHELLOPTS, BASHOPTS, CDPATH, BASH_FUNC_*
 *     https://www.gnu.org/software/bash/manual/bash.html
 *   POSIX.1-2017 Shell Command Language, "Environment Variables": PATH, IFS,
 *     ENV, HOME, TMPDIR, LANG, LC_*, TZ
 *     https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap08.html
 *   git(1), "Environment Variables": GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*,
 *     GIT_SSH, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EXTERNAL_DIFF, GIT_PAGER,
 *     GIT_EDITOR, GIT_EXEC_PATH, GIT_TERMINAL_PROMPT
 *     https://git-scm.com/docs/git#_environment_variables
 *   Node.js CLI: NODE_OPTIONS, NODE_PATH, NODE_EXTRA_CA_CERTS,
 *     NODE_TLS_REJECT_UNAUTHORIZED
 *     https://nodejs.org/api/cli.html#environment-variables
 *   Python CLI: PYTHONPATH, PYTHONSTARTUP, PYTHONHOME, PYTHONUSERBASE
 *     https://docs.python.org/3/using/cmdline.html#environment-variables
 *   Ruby (RUBYOPT, RUBYLIB), perlrun (PERL5OPT, PERL5LIB), java launcher
 *     (JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, JDK_JAVA_OPTIONS)
 *   npm config (npm_config_*), pip (PIP_*), cargo (CARGO_*), each documented
 *     as a way to set any option, which includes a script shell, a registry
 *     or a wrapper program
 *   curl(1) (CURL_CA_BUNDLE, http_proxy and the *_PROXY family) and
 *     OpenSSL (SSL_CERT_FILE, SSL_CERT_DIR, OPENSSL_CONF)
 *   AWS CLI environment variables: AWS_* (credentials, profile, endpoint and
 *     config file overrides)
 *   Windows: COMSPEC, PATHEXT, SystemRoot (cmd.exe), PSModulePath
 *     (about_PSModulePath), NoDefaultCurrentDirectoryInExePath (cmd.exe)
 */
export type EnvRisk = "dangerous" | "sensitive" | "harmless" | "unknown";

export interface EnvClass {
  risk: EnvRisk;
  /** A few words for the prompt. Never holds a value. */
  why: string;
}

/** What the person's own config says. Nothing else adds to or takes from the lists. */
export interface EnvNameOptions {
  /** Names or `PREFIX*` patterns that always ask */
  ask?: readonly string[];
  /** Names or `PREFIX*` patterns that never ask */
  allow?: readonly string[];
}

/** Inert variables: they change colour, locale, logging and test switches only. */
const HARMLESS = new Set(
  [
    "CI",
    "FORCE_COLOR",
    "NO_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "TERM",
    "COLORTERM",
    "COLUMNS",
    "LINES",
    "LANG",
    "LANGUAGE",
    "TZ",
    "DEBUG",
    "VERBOSE",
    "LOG_LEVEL",
    "LOGLEVEL",
    "NODE_ENV",
    "NODE_NO_WARNINGS",
    "NODE_DISABLE_COLORS",
    "NO_UPDATE_NOTIFIER",
    "DO_NOT_TRACK",
    "NEXT_TELEMETRY_DISABLED",
    "ADBLOCK",
    "DISABLE_OPENCOLLECTIVE",
    "DEBIAN_FRONTEND",
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
    "PYTHONHASHSEED",
    "PYTHONWARNINGS",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "GIT_TERMINAL_PROMPT",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_OPTIONAL_LOCKS",
    "GIT_FLUSH",
    "GIT_CURL_VERBOSE",
    "NPM_CONFIG_LOGLEVEL",
    "NPM_CONFIG_COLOR",
    "NPM_CONFIG_FUND",
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "NPM_CONFIG_PROGRESS",
  ].map((n) => n.toLowerCase()),
);

/** `LC_ALL`, `LC_CTYPE`, ...: the locale. `LOCPATH` is not one of them. */
const HARMLESS_PREFIXES = ["lc_"];

/** Names that load code, run a program or decide which program a name means. */
const DANGEROUS_EXACT: Record<string, string> = {
  path: "decides which program a command name runs",
  pathext: "decides which file a command name runs",
  comspec: "names the command interpreter",
  psmodulepath: "decides which PowerShell modules load",
  ifs: "changes how the shell splits words",
  env: "a file the shell runs at start",
  bash_env: "a file the shell runs at start",
  shellopts: "changes how the shell runs",
  bashopts: "changes how the shell runs",
  prompt_command: "a command the shell runs",
  ps4: "the shell expands it as a command",
  cdpath: "decides which folder a cd goes to",
  globignore: "changes how the shell expands a name",
  fpath: "decides which functions the shell loads",
  zdotdir: "decides which startup files zsh runs",
  shell: "names the shell that programs start",
  editor: "a program that tools start",
  visual: "a program that tools start",
  pager: "a program that tools start",
  manpager: "a program that tools start",
  lessopen: "a program that less starts",
  browser: "a program that tools start",
  sudo_askpass: "a program that sudo starts",
  ssh_askpass: "a program that ssh starts",
  home: "decides where tools read their config",
  userprofile: "decides where tools read their config",
  homedrive: "decides where tools read their config",
  homepath: "decides where tools read their config",
  appdata: "decides where tools read their config",
  localappdata: "decides where tools read their config",
  xdg_config_home: "decides where tools read their config",
  xdg_config_dirs: "decides where tools read their config",
  xdg_data_home: "decides where tools read their data",
  xdg_data_dirs: "decides where tools read their data",
  systemroot: "decides where Windows programs load from",
  windir: "decides where Windows programs load from",
  nodefaultcurrentdirectoryinexepath:
    "decides if the current folder is searched",
  locpath: "decides which locale files load",
  nlspath: "decides which message files load",
  gconv_path: "decides which converter libraries load",
  hostaliases: "decides how names resolve",
  classpath: "decides which classes load",
  jdk_java_options: "options for the Java launcher",
  _java_options: "options for the Java launcher",
  java_tool_options: "options for the Java launcher",
  mavenopts: "options for a build tool",
  dotnet_startup_hooks: "code that dotnet runs at start",
  phprc: "decides which PHP config loads",
  php_ini_scan_dir: "decides which PHP config loads",
  lua_init: "code that Lua runs at start",
  lua_path: "decides which Lua code loads",
  goflags: "flags for the go tool",
  goroot: "decides which Go toolchain runs",
  gopath: "decides which Go code loads",
  cc: "names the compiler",
  cxx: "names the compiler",
  cpp: "names the preprocessor",
  ld: "names the linker",
  rustc: "names the compiler",
  rustc_wrapper: "a program that wraps the compiler",
  rustc_workspace_wrapper: "a program that wraps the compiler",
  rustflags: "flags for the compiler",
  makeflags: "flags for make",
  makefiles: "makefiles that make reads",
  library_path: "decides which libraries link",
  compiler_path: "decides which compiler parts run",
  gcc_exec_prefix: "decides which compiler parts run",
  node_tls_reject_unauthorized: "turns off certificate checks",
  git_ssl_no_verify: "turns off certificate checks",
  sslkeylogfile: "writes TLS keys to a file",
  openssl_conf: "decides which OpenSSL config loads",
  openssl_modules: "decides which OpenSSL modules load",
};

/** `[prefix, why]`: any name that starts with the prefix. */
const DANGEROUS_PREFIXES: [string, string][] = [
  ["ld_", "loads libraries into the program"],
  ["dyld_", "loads libraries into the program"],
  ["bash_func_", "defines a shell function"],
  ["git_", "changes what git runs, reads or writes"],
  ["python", "changes which Python code loads"],
  ["ruby", "changes which Ruby code loads"],
  ["perl", "changes which Perl code loads"],
  ["gem_", "changes which Ruby gems load"],
  ["bundle_", "changes which gems bundler installs"],
  ["npm_config_", "sets any npm option, including the script shell"],
  ["pip_", "sets any pip option, including the package index"],
  ["cargo_", "sets any cargo option, including a wrapper program"],
  ["yarn_", "sets any yarn option"],
  ["pnpm_", "sets any pnpm option"],
  ["uv_", "sets any uv option"],
  ["poetry_", "sets any poetry option"],
  ["composer_", "sets any composer option"],
  ["gradle_", "options for a build tool"],
  ["maven_", "options for a build tool"],
  ["cgo_", "flags for the C compiler go runs"],
  ["tf_cli_", "adds arguments to terraform"],
  ["psexecutionpolicy", "changes PowerShell's script policy"],
];

/** Endings that say the value is a program, a wrapper, a path to load from or an option string. */
const DANGEROUS_SUFFIXES: [string, string][] = [
  ["_options", "options for a program, often loading code"],
  ["_opts", "options for a program, often loading code"],
  ["opt", "options for a program, often loading code"],
  ["_path", "decides where code loads from"],
  ["lib", "decides where code loads from"],
  ["_command", "a command that a program runs"],
  ["_wrapper", "a program that wraps another"],
  ["_askpass", "a program that asks for a password"],
  ["_editor", "a program that tools start"],
  ["_pager", "a program that tools start"],
  ["_preload", "loads libraries into the program"],
  ["_hooks", "code that runs at start"],
];

/** Where the network goes and which certificates are trusted. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/_proxy$/i, "sends traffic through another host"],
  [
    /^(ssl|curl|requests|node_extra)_ca|_ca_bundle$|_ca_certs$/i,
    "decides which certificates are trusted",
  ],
  [/^ssl_cert_(file|dir)$/i, "decides which certificates are trusted"],
  [/^(aws|azure|gcp|google|cloudsdk)_/i, "cloud credentials or endpoints"],
  [
    /^(kubeconfig|docker_|dockerconfig)/i,
    "points a client at another cluster or daemon",
  ],
  [/^(tmpdir|temp|tmp)$/i, "decides where temporary files go"],
  [/^xdg_/i, "decides where tools keep files"],
  [
    /^(java|gradle|cargo|rustup|go|dotnet|npm|node)_home$|_home$/i,
    "decides which toolchain runs",
  ],
  [/^dotnet_/i, "changes how dotnet runs"],
  [/^(ssh_auth_sock|gpg_agent_info)$/i, "points at another agent"],
  [/^(http|https|ftp|all|no)_proxy$/i, "sends traffic through another host"],
];

function listMatches(
  list: readonly string[] | undefined,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  return (list ?? []).some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.endsWith("*") ? lower.startsWith(e.slice(0, -1)) : lower === e;
  });
}

/** Classify a variable name. Pure: the value is judged separately (`valueRunsCode`). */
export function classifyEnvName(
  name: string,
  options: EnvNameOptions = {},
): EnvClass {
  const lower = name.toLowerCase();
  if (listMatches(options.allow, name)) {
    return { risk: "harmless", why: "allowed in your config" };
  }
  if (listMatches(options.ask, name)) {
    return { risk: "dangerous", why: "listed in your config" };
  }
  if (
    HARMLESS.has(lower) ||
    HARMLESS_PREFIXES.some((p) => lower.startsWith(p))
  ) {
    return { risk: "harmless", why: "inert" };
  }
  const exact = Object.hasOwn(DANGEROUS_EXACT, lower)
    ? DANGEROUS_EXACT[lower]
    : undefined;
  if (exact) return { risk: "dangerous", why: exact };
  for (const [prefix, why] of DANGEROUS_PREFIXES) {
    if (lower.startsWith(prefix)) return { risk: "dangerous", why };
  }
  for (const [suffix, why] of DANGEROUS_SUFFIXES) {
    if (lower.endsWith(suffix)) return { risk: "dangerous", why };
  }
  for (const [re, why] of SENSITIVE_PATTERNS) {
    if (re.test(name)) return { risk: "sensitive", why };
  }
  if (isSecretName(name) || looksSecret(name)) {
    return { risk: "sensitive", why: "a credential variable" };
  }
  return { risk: "unknown", why: "no known effect" };
}

/**
 * Does the value run code when the shell expands it: `$(...)`, backticks,
 * process substitution, `${x@P}` and the like? Single quotes hide these, but
 * the scan is a text scan and ignores them, which only asks more often.
 */
export function valueRunsCode(value: string): boolean {
  return /\$\(|`|<\(|>\(|\$\{[^}]*@[PQEAaK]/.test(value);
}
