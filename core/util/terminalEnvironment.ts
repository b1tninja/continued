import {
  scrubEnvironment,
  urlHasCredentials,
  type ScrubPolicy,
} from "./scrubEnvironment";

/**
 * The environment a command the agent starts is given. The host's secrets
 * (API keys, cloud credentials, agent sockets) are not passed on: a command
 * that the model writes, a loop check and a hook run with the host's
 * environment minus those names. `terminal.environment` in config.yaml picks
 * the mode and `terminal.passEnv` names the variables to keep.
 *
 * Kept free of every provider package, so the GUI may import it.
 */
export type TerminalEnvironmentMode = "scrub" | "inherit" | "allowlist";

export interface TerminalEnvironmentSettings {
  /** `scrub` (default): remove secret-looking names. `inherit`: pass everything. `allowlist`: only the basics and `allow`. */
  environment?: TerminalEnvironmentMode;
  /** Exact names that always pass, whatever the mode. */
  passEnv?: readonly string[];
  /** Extra names or patterns kept in `allowlist` mode. */
  allow?: readonly string[];
}

/**
 * One static sentence for the terminal tool's description. It does not change
 * with the setting, so the prompt prefix stays cacheable.
 */
export const TERMINAL_ENV_NOTICE =
  "Secrets in the host environment are not passed to commands; the person can allow a name in terminal.passEnv.";

/** Names WSL needs to forward variables and to know where it is. */
const WSL_BASICS = ["WSLENV", "WSL_DISTRO_NAME", "WSL_INTEROP"];

let configured: TerminalEnvironmentSettings | undefined;
let configuredSource: "user-config" | "assistant-config" | undefined;
let configuredNotices: string[] = [];

/** Set from config.yaml; `undefined` goes back to the default (`scrub`). */
export function setTerminalEnvironmentSettings(
  settings: TerminalEnvironmentSettings | undefined,
): void {
  configured = settings;
  configuredSource = settings?.environment ? "user-config" : undefined;
  configuredNotices = [];
}

/** How loose a mode is: a higher rank passes more of the host's environment. */
const LOOSENESS: Record<TerminalEnvironmentMode, number> = {
  allowlist: 0,
  scrub: 1,
  inherit: 2,
};

export interface TerminalSettingsResolution {
  settings: TerminalEnvironmentSettings | undefined;
  source: "user-config" | "assistant-config" | undefined;
  /** One sentence for each value that was ignored. */
  notices: string[];
}

/**
 * Merge the person's own settings (user-level config.yaml) with settings that
 * came from an assistant, the hub or a project folder. Only the person's own
 * source may loosen: `inherit`, `passEnv` and `allow` from the other source are
 * ignored, and a tighter `environment` from it is kept. Pure.
 */
export function resolveTerminalSettings(
  user: TerminalEnvironmentSettings | undefined,
  other: TerminalEnvironmentSettings | undefined,
): TerminalSettingsResolution {
  const notices: string[] = [];
  const settings: TerminalEnvironmentSettings = {};
  let source: TerminalSettingsResolution["source"];
  if (user?.environment) {
    settings.environment = user.environment;
    source = "user-config";
  }
  if (user?.passEnv?.length) settings.passEnv = user.passEnv;
  if (user?.allow?.length) settings.allow = user.allow;

  const floor = LOOSENESS[user?.environment ?? "scrub"];
  if (other?.environment) {
    if (LOOSENESS[other.environment] <= floor) {
      // Tighter than (or equal to) the person's own choice: honoured.
      if (other.environment !== (user?.environment ?? "scrub")) {
        settings.environment = other.environment;
        source = "assistant-config";
      }
    } else {
      notices.push(
        `terminal.environment: ${other.environment} in the assistant or project configuration was ignored: commands pass on the host's secrets only when it is set in your own config.yaml (Settings, Tools, Commands and secrets).`,
      );
    }
  }
  if (other?.passEnv?.length) {
    notices.push(
      "terminal.passEnv in the assistant or project configuration was ignored: names that pass secrets to commands are taken from your own config.yaml only.",
    );
  }
  if (other?.allow?.length) {
    notices.push(
      "terminal.allow in the assistant or project configuration was ignored: it is taken from your own config.yaml only.",
    );
  }
  configured = Object.keys(settings).length ? settings : undefined;
  configuredSource = source;
  configuredNotices = notices;
  return { settings: configured, source, notices };
}

export interface TerminalEnvironmentStatus {
  mode: TerminalEnvironmentMode;
  /** `env`: CONTINUE_TERMINAL_ENV is set and wins. */
  source: "env" | "user-config" | "assistant-config" | "default";
  /** The value of CONTINUE_TERMINAL_ENV when it is set and valid. */
  envVar?: TerminalEnvironmentMode;
  passEnv: string[];
  allow: string[];
  notices: string[];
}

export function getTerminalEnvironmentStatus(
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): TerminalEnvironmentStatus {
  const envVar = parseMode(hostEnv.CONTINUE_TERMINAL_ENV);
  return {
    mode: getTerminalEnvironmentMode(hostEnv),
    source: envVar ? "env" : (configuredSource ?? "default"),
    ...(envVar ? { envVar } : {}),
    passEnv: [...(configured?.passEnv ?? [])],
    allow: [...(configured?.allow ?? [])],
    notices: [...configuredNotices],
  };
}

function parseMode(
  value: string | undefined,
): TerminalEnvironmentMode | undefined {
  const v = value?.trim().toLowerCase();
  return v === "scrub" || v === "inherit" || v === "allowlist" ? v : undefined;
}

/** The effective mode: the environment variable wins over config.yaml. */
export function getTerminalEnvironmentMode(
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): TerminalEnvironmentMode {
  return (
    parseMode(hostEnv.CONTINUE_TERMINAL_ENV) ??
    configured?.environment ??
    "scrub"
  );
}

/**
 * `base` (default: the process environment) as a command should see it. In
 * `inherit` mode the result is a copy with every defined value, as before.
 */
export function terminalEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
  opts: { platform?: NodeJS.Platform } = {},
): Record<string, string> {
  const mode = getTerminalEnvironmentMode();
  if (mode === "inherit") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
    return out;
  }
  return scrubEnvironment(base, scrubPolicyFor(mode, configured, opts.platform))
    .env;
}

function scrubPolicyFor(
  mode: TerminalEnvironmentMode,
  settings: TerminalEnvironmentSettings | undefined,
  platform?: NodeJS.Platform,
): ScrubPolicy {
  return {
    mode: mode === "allowlist" ? "allowlist" : "denylist",
    passThrough: settings?.passEnv ?? [],
    allow: [...WSL_BASICS, ...(settings?.allow ?? [])],
    ...(platform ? { platform } : {}),
  };
}

export interface TerminalEnvironmentPreview {
  /** Names a command would not get in this mode. Never values. */
  removed: string[];
  /** Names a command would get. */
  kept: string[];
}

/**
 * What `mode` would do to `env`, as names. The GUI passes empty values with
 * `credentialUrlNames` marking variables whose value is a URL with a password
 * in it (see `credentialUrlNames`), so no value leaves the process.
 */
export function previewTerminalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  mode: TerminalEnvironmentMode,
  settings?: Pick<TerminalEnvironmentSettings, "passEnv" | "allow">,
  platform?: NodeJS.Platform,
): TerminalEnvironmentPreview {
  const names = Object.keys(env).filter((k) => env[k] !== undefined);
  if (mode === "inherit") return { removed: [], kept: names };
  const { env: out, removed } = scrubEnvironment(
    env,
    scrubPolicyFor(mode, settings, platform),
  );
  return { removed, kept: Object.keys(out) };
}

/** Names of variables whose value is a URL with a user name or password. */
export function credentialUrlNames(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.keys(env).filter((k) => {
    const v = env[k];
    return v !== undefined && urlHasCredentials(v);
  });
}
