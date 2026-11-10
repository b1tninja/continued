import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { getConfigYamlPath, getContinueGlobalPath } from "../../../util/paths";
import { AuditTrail, DEFAULT_RETENTION_DAYS } from "./trail";

/**
 * The audit trail of this process: where it lives and whether it is on.
 *
 * On by default. The trail is local, masked and capped (30 days, 20 MB a
 * file), and never leaves the machine. It is turned off with `audit.enabled:
 * false` in the global config.yaml or `CONTINUE_AUDIT=off` in the environment;
 * the environment wins.
 */
export function auditDir(): string {
  return path.join(getContinueGlobalPath(), "audit");
}

const OFF = new Set(["off", "0", "false", "no", "disabled"]);
const ON = new Set(["on", "1", "true", "yes", "enabled"]);

/** The environment's answer: true, false, or undefined when it says nothing. */
export function auditEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean | undefined {
  const v = env.CONTINUE_AUDIT?.trim().toLowerCase();
  if (!v) return undefined;
  if (OFF.has(v)) return false;
  if (ON.has(v)) return true;
  return undefined;
}

/** `audit.enabled` from a config.yaml text; undefined when absent or unreadable. */
export function auditEnabledFromYaml(text: string): boolean | undefined {
  try {
    const raw = YAML.parse(text);
    const value = raw?.audit?.enabled;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function auditSettings(
  env: Record<string, string | undefined> = process.env,
  configText?: string,
): { enabled: boolean; retentionDays: number } {
  let text = configText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(getConfigYamlPath(), "utf8");
    } catch {
      text = "";
    }
  }
  let retentionDays = DEFAULT_RETENTION_DAYS;
  try {
    const days = YAML.parse(text)?.audit?.retentionDays;
    if (typeof days === "number" && days > 0) retentionDays = days;
  } catch {
    // keep the default
  }
  return {
    // A test run must not write into the developer's real audit directory
    enabled:
      auditEnabledFromEnv(env) ??
      (env.VITEST ? false : auditEnabledFromYaml(text)) ??
      true,
    retentionDays,
  };
}

let shared: AuditTrail | undefined;

/**
 * The process's trail. The first call reads the settings and prunes old files;
 * `onError` is only used by that first call.
 */
export function getAuditTrail(onError?: (message: string) => void): AuditTrail {
  if (shared) return shared;
  let trail: AuditTrail;
  try {
    const s = auditSettings();
    trail = new AuditTrail({
      dir: auditDir(),
      enabled: s.enabled,
      retentionDays: s.retentionDays,
      onError: onError ?? ((m) => console.warn(m)),
    });
    if (trail.enabled) trail.prune();
  } catch {
    // no global directory to resolve: an off trail is a no-op
    trail = new AuditTrail({ dir: "", enabled: false });
  }
  shared = trail;
  return trail;
}

/** For tests */
export function setAuditTrailForTests(trail: AuditTrail | undefined): void {
  shared = trail;
}
