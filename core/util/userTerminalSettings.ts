import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import type { ConfigYaml } from "@continuedev/config-yaml";
import { getContinueGlobalPath, editConfigFile } from "./paths";
import type {
  TerminalEnvironmentMode,
  TerminalEnvironmentSettings,
} from "./terminalEnvironment";

/**
 * The person's own `terminal:` settings: the one in the user-level config.yaml
 * (the file the settings page writes), read directly. An assistant, a hub
 * config or a project folder cannot be this source; see
 * resolveTerminalSettings for what those may still set.
 */
const MODES = ["scrub", "inherit", "allowlist"];

function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return list.length ? list.map((v) => v.trim()) : undefined;
}

/** Keep only well-formed fields of a parsed `terminal:` value. */
export function sanitizeTerminalSettings(
  raw: unknown,
): TerminalEnvironmentSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: TerminalEnvironmentSettings = {};
  if (typeof r.environment === "string" && MODES.includes(r.environment)) {
    out.environment = r.environment as TerminalEnvironmentMode;
  }
  const passEnv = names(r.passEnv);
  if (passEnv) out.passEnv = passEnv;
  const allow = names(r.allow);
  if (allow) out.allow = allow;
  return Object.keys(out).length ? out : undefined;
}

export function readUserTerminalSettings(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): TerminalEnvironmentSettings | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return sanitizeTerminalSettings(
      (YAML.parse(fs.readFileSync(file, "utf8")) as any)?.terminal,
    );
  } catch {
    return undefined;
  }
}

/** Set or remove `terminal` in a config.yaml object; empty fields are dropped. */
export function applyTerminalSettings(
  config: ConfigYaml,
  settings: TerminalEnvironmentSettings,
): ConfigYaml {
  const terminal: Record<string, unknown> = {
    ...((config as any).terminal ?? {}),
  };
  for (const key of ["environment", "passEnv", "allow"] as const) {
    if (!(key in settings)) continue;
    const value = settings[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete terminal[key];
    } else terminal[key] = value;
  }
  const next: Record<string, unknown> = { ...config };
  if (Object.keys(terminal).length) next.terminal = terminal;
  else delete next.terminal;
  return next as ConfigYaml;
}

/** Write to the user's main config.yaml, keeping comments. False when there is none. */
export function saveUserTerminalSettings(
  settings: TerminalEnvironmentSettings,
): boolean {
  let saved = false;
  editConfigFile(
    (c) => c,
    (config) => {
      saved = true;
      return applyTerminalSettings(config, settings);
    },
    "main",
  );
  return saved;
}
