import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import type { ToolPermissions } from "../tools/permissions/rules";
import { getContinueGlobalPath } from "./paths";

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : undefined;

/**
 * The person's own `toolPermissions` from the user-level config.yaml, read
 * directly: the one source that may add `allow` rules (see
 * resolveToolPermissions). Unreadable or missing is no rules, never a throw.
 */
export function readUserToolPermissions(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): ToolPermissions | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = (YAML.parse(fs.readFileSync(file, "utf8")) as any)
      ?.toolPermissions;
    if (!raw || typeof raw !== "object") return undefined;
    return {
      allow: strings(raw.allow),
      ask: strings(raw.ask),
      deny: strings(raw.deny),
    };
  } catch {
    return undefined;
  }
}
