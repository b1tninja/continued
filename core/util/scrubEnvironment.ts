/**
 * The environment a command is given, with secrets taken out
 * (plans/jail-network.md, section 3, "What else is in the jail"). Pure: it
 * reads the `env` it is passed and returns a new object. Nothing calls it yet;
 * `runTerminalCommand` still spreads the whole of `process.env` into commands
 * that do not run in a container, and changing that is the owner's decision.
 *
 * Two modes:
 * - `denylist` (the default): everything passes except names that look like
 *   they carry a secret (the default patterns below, plus `strip`) and
 *   variables whose value is a URL with a user name or password in it.
 * - `allowlist`: only the names in `DEFAULT_ALLOWLIST` and `allow` pass. This
 *   is what a whole-process jail wants: the environment is built from a short
 *   list, not scrubbed from the host's.
 *
 * `passThrough` names always pass in either mode: the person's explicit "this
 * one is fine". Without it a name that matches a secret pattern is removed.
 *
 * The result lists the names it removed, never the values, so a notice can say
 * what the command did not get.
 */
export interface ScrubPolicy {
  mode?: "denylist" | "allowlist";
  /** Extra names or patterns to remove (denylist mode). `*` matches any run of characters. */
  strip?: readonly string[];
  /** Extra names or patterns to keep (allowlist mode), beside `DEFAULT_ALLOWLIST`. */
  allow?: readonly string[];
  /** Names that are kept whatever else says. Exact names only, never patterns. */
  passThrough?: readonly string[];
  /** Skip `DEFAULT_SECRET_PATTERNS`. Default false. */
  noDefaultSecrets?: boolean;
  /** Names are case-insensitive on Windows. Defaults to this machine's platform. */
  platform?: NodeJS.Platform;
}

export interface ScrubResult {
  env: Record<string, string>;
  /** Names removed, in the order they were seen. Never values. */
  removed: string[];
}

/**
 * Names and patterns that carry a secret or the means to get one: keys,
 * tokens, passwords, cloud and provider prefixes, this product's own
 * variables, and the agent and daemon sockets a shell inherits.
 */
export const DEFAULT_SECRET_PATTERNS: readonly string[] = [
  "*API_KEY",
  "*APIKEY",
  "*_KEY",
  "*TOKEN",
  "*SECRET",
  "*SECRET_KEY",
  "*PASSWORD",
  "*PASSWD",
  "*_PASS",
  "*CREDENTIAL",
  "*CREDENTIALS",
  "*PRIVATE_KEY",
  "*ACCESS_KEY",
  "*_PWD",
  "*CONNECTION_STRING",
  "AWS_*",
  "AZURE_*",
  "GCP_*",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_*",
  "CONTINUOUS_*",
  "CONTINUE_*",
  "ANTHROPIC_*",
  "OPENAI_*",
  "BEDROCK_*",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "KUBECONFIG",
  "DATABASE_URL",
  "PGPASSWORD",
  "MYSQL_PWD",
  "NETRC",
];

/**
 * Names an allowlisted environment keeps: enough for a shell and common tools
 * to work, on POSIX and Windows, and nothing that carries a credential.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Windows
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
}

/** A `scheme://user:password@host` URL, or any URL with a user name in it. */
export function urlHasCredentials(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value.trim());
}

export function scrubEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  policy: ScrubPolicy = {},
): ScrubResult {
  // A webview has no `process`; callers there pass the platform.
  const platform =
    policy.platform ??
    (typeof process === "undefined" ? undefined : process.platform);
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const passThrough = new Set((policy.passThrough ?? []).map(fold));
  const allowlist = policy.mode === "allowlist";

  const defaultSecrets = policy.noDefaultSecrets
    ? []
    : DEFAULT_SECRET_PATTERNS.map(globToRegExp);
  const stripPatterns = [
    ...defaultSecrets,
    ...(policy.strip ?? []).map(globToRegExp),
  ];
  const allowPatterns = [...DEFAULT_ALLOWLIST, ...(policy.allow ?? [])].map(
    globToRegExp,
  );

  const out: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    let keep: boolean;
    if (passThrough.has(fold(name))) keep = true;
    else if (allowlist) {
      // An allowed name that the secret list also names still goes, unless it
      // was passed through: `allow: ["*"]` is not a way to leak the key.
      keep =
        allowPatterns.some((r) => r.test(name)) &&
        !defaultSecrets.some((r) => r.test(name)) &&
        !urlHasCredentials(value);
    } else {
      keep =
        !stripPatterns.some((r) => r.test(name)) && !urlHasCredentials(value);
    }
    if (keep) out[name] = value;
    else removed.push(name);
  }
  return { env: out, removed };
}
