import { scrubEnvironment, type ScrubPolicy } from "./scrubEnvironment";

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

/** Set from config.yaml; `undefined` goes back to the default (`scrub`). */
export function setTerminalEnvironmentSettings(
  settings: TerminalEnvironmentSettings | undefined,
): void {
  configured = settings;
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
  const policy: ScrubPolicy = {
    mode: mode === "allowlist" ? "allowlist" : "denylist",
    passThrough: configured?.passEnv ?? [],
    allow: [...WSL_BASICS, ...(configured?.allow ?? [])],
    ...(opts.platform ? { platform: opts.platform } : {}),
  };
  return scrubEnvironment(base, policy).env;
}
