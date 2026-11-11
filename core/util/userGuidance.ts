import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import type { GuidanceInput } from "../tools/permissions/auto/guidance";
import type { ToolPermissions } from "../tools/permissions/rules";
import { getContinueGlobalPath } from "./paths";

/**
 * The person's own reviewer guidance: `toolPermissions.auto.guidance` in the
 * user-level config.yaml, read directly, as readUserTerminalSettings reads
 * `terminal:`. Guidance may loosen what the reviewer allows, so an assistant,
 * a hub block or a repository file cannot be its source (#497: only the
 * user's own config may loosen). Entries are returned as written; the reviewer
 * validates them (assembleGuidance) before use.
 */
function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

export function sanitizeUserGuidance(raw: unknown): GuidanceInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const block = list(r.block);
  const allow = list(r.allow);
  if (!block && !allow) return undefined;
  return { ...(block ? { block } : {}), ...(allow ? { allow } : {}) };
}

export function readUserGuidance(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): GuidanceInput | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as any;
    return sanitizeUserGuidance(parsed?.toolPermissions?.auto?.guidance);
  } catch {
    return undefined;
  }
}

export interface GuidanceResolution {
  /** What the reviewer may be given: the person's own, and nothing else. */
  guidance: GuidanceInput | undefined;
  /** One sentence when text from another source was left out. */
  notices: string[];
}

/**
 * Keep the person's own guidance and drop what an assistant, a hub block or a
 * folder added. Pure.
 */
export function resolveGuidance(
  user: GuidanceInput | undefined,
  other: GuidanceInput | undefined,
): GuidanceResolution {
  const own = new Set([...(user?.block ?? []), ...(user?.allow ?? [])]);
  const ignored = [...(other?.block ?? []), ...(other?.allow ?? [])].filter(
    (g) => !own.has(g),
  );
  return {
    guidance: user,
    notices: ignored.length
      ? [
          `${ignored.length} reviewer guidance ${ignored.length === 1 ? "entry" : "entries"} from the assistant, a block or a workspace file ${ignored.length === 1 ? "was" : "were"} ignored: only guidance in your own config.yaml is given to the reviewer. Move ${ignored.length === 1 ? "it" : "them"} there to use ${ignored.length === 1 ? "it" : "them"}.`,
        ]
      : [],
  };
}

/**
 * `toolPermissions` as the reviewer may use it: `auto.guidance` is the
 * person's own and nothing the config carried. Rules are untouched.
 */
export function withOwnGuidance<T extends ToolPermissions | undefined>(
  permissions: T,
  user: GuidanceInput | undefined,
): { permissions: T; notices: string[] } {
  if (!permissions?.auto?.guidance) return { permissions, notices: [] };
  const { guidance, notices } = resolveGuidance(
    user,
    permissions?.auto?.guidance,
  );
  const auto = { ...permissions?.auto };
  if (guidance) auto.guidance = guidance;
  else delete auto.guidance;
  return {
    permissions: { ...permissions, auto } as T,
    notices,
  };
}
