import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";
import { recordedFolderRules } from "./folderRules";
import type { RuleSourcesInput } from "./effectiveRules";
import { type PolicyLevels } from "./policy";
import { readPolicyFile } from "./settingsFile";
import type { RuleSource, ToolPermissions } from "./rules";

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/** The rule lists of a parsed `toolPermissions` value; anything else is dropped. */
export function sanitizeToolPermissions(
  raw: unknown,
): ToolPermissions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ToolPermissions = {};
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = strings(r[key]);
    if (list?.length) out[key] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The person's own `toolPermissions`, read directly from their config.yaml. */
export function readUserToolPermissions(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): ToolPermissions | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return sanitizeToolPermissions(
      (YAML.parse(fs.readFileSync(file, "utf8")) as any)?.toolPermissions,
    );
  } catch {
    return undefined;
  }
}

/** What the CLI keeps in permissions.yaml beside the shared policy keys. */
function readCliLists(file: string): RuleSourcesInput["cliFile"] {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) as any;
    const out: NonNullable<RuleSourcesInput["cliFile"]> = {};
    for (const key of ["allow", "ask", "exclude"] as const) {
      const list = strings(raw?.[key]);
      if (list?.length) out[key] = list;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

const LISTS = ["allow", "ask", "deny"] as const;

/**
 * Split the merged `toolPermissions` of a loaded configuration by who wrote
 * each rule: the person's own config.yaml first, then workspace files, and
 * what neither accounts for is the assistant's. Every merged rule lands in
 * exactly one bucket, so the rules that run are the same ones, only named.
 */
export function partitionMergedRules(
  merged: ToolPermissions | undefined,
  user: ToolPermissions | undefined,
  folder: { permissions: ToolPermissions }[],
): Partial<Record<"user-config" | "folder" | "assistant", ToolPermissions>> {
  if (!merged) return {};
  const out: Partial<
    Record<"user-config" | "folder" | "assistant", ToolPermissions>
  > = {};
  const put = (
    bucket: "user-config" | "folder" | "assistant",
    list: (typeof LISTS)[number],
    raw: string,
  ) => ((out[bucket] ??= {})[list] ??= []).push(raw);
  for (const list of LISTS) {
    const claim = (perms: ToolPermissions[]) => {
      const pool = new Map<string, number>();
      for (const p of perms) {
        for (const raw of p[list] ?? [])
          pool.set(raw, (pool.get(raw) ?? 0) + 1);
      }
      return pool;
    };
    const userPool = claim(user ? [user] : []);
    // A workspace file's allow rules were removed before the merge
    const folderPool = claim(
      list === "allow" ? [] : folder.map((f) => f.permissions),
    );
    for (const raw of merged[list] ?? []) {
      if ((userPool.get(raw) ?? 0) > 0) {
        userPool.set(raw, userPool.get(raw)! - 1);
        put("user-config", list, raw);
      } else if ((folderPool.get(raw) ?? 0) > 0) {
        folderPool.set(raw, folderPool.get(raw)! - 1);
        put("folder", list, raw);
      } else {
        put("assistant", list, raw);
      }
    }
  }
  return out;
}

/**
 * The rules that run, by source, for the evaluator: the loaded configuration's
 * own `toolPermissions`, so a rule is named after the file it came from.
 */
export function ruleSourcesOfLoadedConfig(
  merged: ToolPermissions | undefined,
): Partial<Record<RuleSource, ToolPermissions>> {
  return partitionMergedRules(
    merged,
    readUserToolPermissions(),
    recordedFolderRules(),
  );
}

export interface ReadRuleSourcesOptions {
  /** Defaults to config.yaml in the global folder */
  configFile?: string;
  /** Defaults to permissions.yaml in the global folder */
  permissionsFile?: string;
  /**
   * `toolPermissions` of the loaded configuration (user, assistant and
   * workspace merged). What the person's own file and the workspace files do
   * not account for is the assistant's.
   */
  merged?: ToolPermissions;
  /** The levels in use (the IDE's session levels); the file's otherwise */
  levels?: PolicyLevels;
  /** Include the workspace files recorded by the last config load */
  withFolder?: boolean;
}

/** Read every rule source from disk (and the last config load) for the Permissions page and CLI. */
export function readRuleSources(
  options: ReadRuleSourcesOptions = {},
): RuleSourcesInput {
  const global = getContinueGlobalPath();
  const user = readUserToolPermissions(
    options.configFile ?? path.join(global, "config.yaml"),
  );
  const permissionsFile =
    options.permissionsFile ?? path.join(global, "permissions.yaml");
  const { settings, notices } = readPolicyFile(permissionsFile);
  const folder = options.withFolder === false ? [] : recordedFolderRules();
  const assistant = partitionMergedRules(
    options.merged,
    user,
    folder,
  ).assistant;
  return {
    user,
    assistant,
    folder,
    cliFile: readCliLists(permissionsFile),
    floor: settings.floor,
    levels: options.levels ?? settings.levels,
    builtin: settings.builtin,
    maxNewPlanItems: settings.maxNewPlanItems,
    questions: settings.questions,
    notices,
  };
}
