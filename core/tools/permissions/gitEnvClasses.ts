import type { EnvRisk } from "./envNames";

/**
 * The class chosen, name by name, for every `GIT_*` variable that the git
 * manual lists (corpus/gitEnvNames.json). `classifyEnvName` treats the whole
 * `git_` prefix as dangerous and lets a short list of inert names through, so a
 * name git adds later is dangerous until someone reads it. This table is the
 * written reason for each name that exists today, and gitEnvNames.vitest.ts
 * fails when a manual name has no row here or when a row disagrees with what
 * `classifyEnvName` answers.
 *
 * Some rows are stricter than they need to be (a trace switch, a verbosity
 * level): they stay dangerous because a value can also be a file path or
 * change what is read, and moving one to harmless needs its own reason and
 * test. Read the reason, not only the class.
 *
 *   runs      names a program or config that makes git run one
 *   where     decides which repository, config, object or file git reads/writes
 *   trace     writes diagnostics, to a file when the value is a path
 *   behaviour changes a check or a default inside git
 *   inert     colour, identity text or locking only (harmless)
 */
export const GIT_ENV: Record<string, { risk: EnvRisk; why: string }> = {
  GIT_INDEX_FILE: { risk: "dangerous", why: "where: another index file" },
  GIT_INDEX_VERSION: { risk: "dangerous", why: "behaviour: index format" },
  GIT_OBJECT_DIRECTORY: { risk: "dangerous", why: "where: object store" },
  GIT_ALTERNATE_OBJECT_DIRECTORIES: {
    risk: "dangerous",
    why: "where: extra object stores git trusts",
  },
  GIT_DIR: { risk: "dangerous", why: "where: another repository" },
  GIT_WORK_TREE: { risk: "dangerous", why: "where: another working tree" },
  GIT_NAMESPACE: { risk: "dangerous", why: "where: which refs are seen" },
  GIT_CEILING_DIRECTORIES: {
    risk: "dangerous",
    why: "where: repository discovery",
  },
  GIT_DISCOVERY_ACROSS_FILESYSTEM: {
    risk: "dangerous",
    why: "where: repository discovery",
  },
  GIT_COMMON_DIR: { risk: "dangerous", why: "where: shared worktree files" },
  GIT_DEFAULT_HASH: { risk: "dangerous", why: "behaviour: new repositories" },
  GIT_DEFAULT_REF_FORMAT: {
    risk: "dangerous",
    why: "behaviour: new repositories",
  },
  GIT_REFERENCE_BACKEND: { risk: "dangerous", why: "where: ref storage URI" },
  GIT_AUTHOR_NAME: { risk: "harmless", why: "inert: identity text" },
  GIT_AUTHOR_EMAIL: { risk: "harmless", why: "inert: identity text" },
  GIT_AUTHOR_DATE: { risk: "harmless", why: "inert: identity text" },
  GIT_COMMITTER_NAME: { risk: "harmless", why: "inert: identity text" },
  GIT_COMMITTER_EMAIL: { risk: "harmless", why: "inert: identity text" },
  GIT_COMMITTER_DATE: { risk: "harmless", why: "inert: identity text" },
  GIT_DIFF_OPTS: { risk: "dangerous", why: "behaviour: diff output only" },
  GIT_EXTERNAL_DIFF: { risk: "dangerous", why: "runs: a diff program" },
  GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE: {
    risk: "dangerous",
    why: "behaviour: how the diff program exit is read",
  },
  GIT_DIFF_PATH_COUNTER: {
    risk: "dangerous",
    why: "behaviour: set by git for the diff program",
  },
  GIT_DIFF_PATH_TOTAL: {
    risk: "dangerous",
    why: "behaviour: set by git for the diff program",
  },
  GIT_MERGE_VERBOSITY: { risk: "dangerous", why: "behaviour: output only" },
  GIT_PAGER: { risk: "dangerous", why: "runs: a pager program" },
  GIT_PROGRESS_DELAY: { risk: "dangerous", why: "behaviour: output only" },
  GIT_EDITOR: { risk: "dangerous", why: "runs: an editor program" },
  GIT_SEQUENCE_EDITOR: { risk: "dangerous", why: "runs: an editor program" },
  GIT_SSH: { risk: "dangerous", why: "runs: replaces ssh" },
  GIT_SSH_COMMAND: { risk: "dangerous", why: "runs: a shell command for ssh" },
  GIT_SSH_VARIANT: { risk: "dangerous", why: "behaviour: how ssh is called" },
  GIT_SSL_NO_VERIFY: {
    risk: "dangerous",
    why: "behaviour: no certificate check",
  },
  GIT_ATTR_SOURCE: {
    risk: "dangerous",
    why: "where: attributes (filters run)",
  },
  GIT_ASKPASS: { risk: "dangerous", why: "runs: a password program" },
  GIT_TERMINAL_PROMPT: { risk: "harmless", why: "inert: prompt on or off" },
  GIT_CONFIG_GLOBAL: {
    risk: "dangerous",
    why: "runs: config can set programs",
  },
  GIT_CONFIG_SYSTEM: {
    risk: "dangerous",
    why: "runs: config can set programs",
  },
  GIT_CONFIG_NOSYSTEM: {
    risk: "dangerous",
    why: "behaviour: which config is read",
  },
  GIT_FLUSH: { risk: "harmless", why: "inert: output flushing" },
  GIT_TRACE: { risk: "dangerous", why: "trace: a path value writes a file" },
  GIT_TRACE_FSMONITOR: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_PACK_ACCESS: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_PACKET: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_PACKFILE: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_PERFORMANCE: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_REFS: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_SETUP: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_SHALLOW: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_CURL: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_CURL_NO_DATA: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE2: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE2_EVENT: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE2_PERF: { risk: "dangerous", why: "trace: writes a file" },
  GIT_TRACE_REDACT: {
    risk: "dangerous",
    why: "trace: turns off hiding of secrets in traces",
  },
  GIT_NO_REPLACE_OBJECTS: { risk: "dangerous", why: "behaviour: ref lookup" },
  GIT_LITERAL_PATHSPECS: { risk: "dangerous", why: "behaviour: path matching" },
  GIT_GLOB_PATHSPECS: { risk: "dangerous", why: "behaviour: path matching" },
  GIT_NOGLOB_PATHSPECS: { risk: "dangerous", why: "behaviour: path matching" },
  GIT_ICASE_PATHSPECS: { risk: "dangerous", why: "behaviour: path matching" },
  GIT_NO_LAZY_FETCH: { risk: "dangerous", why: "behaviour: network fetches" },
  GIT_REFLOG_ACTION: { risk: "dangerous", why: "behaviour: reflog text" },
  GIT_REF_PARANOIA: { risk: "dangerous", why: "behaviour: a safety check" },
  GIT_COMMIT_GRAPH_PARANOIA: {
    risk: "dangerous",
    why: "behaviour: a safety check",
  },
  GIT_ALLOW_PROTOCOL: {
    risk: "dangerous",
    why: "behaviour: allowed transports",
  },
  GIT_PROTOCOL_FROM_USER: {
    risk: "dangerous",
    why: "behaviour: allowed transports",
  },
  GIT_PROTOCOL: { risk: "dangerous", why: "behaviour: wire protocol version" },
  GIT_OPTIONAL_LOCKS: { risk: "harmless", why: "inert: fewer lock files" },
  GIT_REDIRECT_STDIN: { risk: "dangerous", why: "where: a file git reads" },
  GIT_REDIRECT_STDOUT: { risk: "dangerous", why: "where: a file git writes" },
  GIT_REDIRECT_STDERR: { risk: "dangerous", why: "where: a file git writes" },
  GIT_PRINT_SHA1_ELLIPSIS: {
    risk: "dangerous",
    why: "behaviour: output only (deprecated)",
  },
  GIT_ADVICE: { risk: "dangerous", why: "behaviour: output only" },
  GIT_CONFIG: { risk: "dangerous", why: "runs: config can set programs" },
  GIT_CONFIG_COUNT: {
    risk: "dangerous",
    why: "runs: config can set programs",
  },
  "GIT_CONFIG_KEY_<n>": {
    risk: "dangerous",
    why: "runs: a config key such as core.pager or an alias",
  },
  "GIT_CONFIG_VALUE_<n>": {
    risk: "dangerous",
    why: "runs: a config value such as a program",
  },
  GIT_EXEC_PATH: { risk: "dangerous", why: "runs: where git-* programs load" },
  GIT_CONFIG_PARAMETERS: {
    risk: "dangerous",
    why: "runs: the channel for -c settings",
  },
  GIT_TEMPLATE_DIR: {
    risk: "dangerous",
    why: "runs: hooks copied into a repo",
  },
  GIT_PROXY_COMMAND: { risk: "dangerous", why: "runs: a proxy program" },
  GIT_CURL_VERBOSE: { risk: "harmless", why: "inert: curl diagnostics" },
};
