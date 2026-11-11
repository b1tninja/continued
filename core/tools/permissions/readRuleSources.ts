import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";
import { recordedAssistantAllows, recordedFolderRules } from "./folderRules";
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

/** SHA-256 of a file's text: what the editor compares to see that nobody changed it since. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface UserConfigFile {
  path: string;
  /**
   * `ok`: read, with or without rules. `missing`: no file. `broken`: it is
   * there but cannot be read as rules; never the same as "no rules".
   */
  state: "ok" | "missing" | "broken";
  error?: string;
  text?: string;
  hash?: string;
  permissions?: ToolPermissions;
}

const LIST_KEYS = ["allow", "ask", "deny"] as const;

/**
 * Read the person's own config.yaml and say what state it is in. A file that
 * does not parse, or whose `toolPermissions` is not a mapping of lists of
 * strings, is `broken` with the reason: the editor must not show it as having
 * no rules and then write over it.
 */
export function readUserConfigFile(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): UserConfigFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return { path: file, state: "missing" };
    return {
      path: file,
      state: "broken",
      error: `config.yaml could not be read: ${e?.message ?? e}`,
    };
  }
  const base = { path: file, text, hash: hashText(text) };
  const doc = YAML.parseDocument(text.replace(/^﻿/, ""));
  if (doc.errors.length > 0) {
    return {
      ...base,
      state: "broken",
      error: `config.yaml cannot be parsed: ${doc.errors[0].message}`,
    };
  }
  const root = doc.toJS();
  if (root === null || root === undefined) return { ...base, state: "ok" };
  if (typeof root !== "object" || Array.isArray(root)) {
    return {
      ...base,
      state: "broken",
      error: "config.yaml is not a mapping at the top level.",
    };
  }
  const raw = (root as any).toolPermissions;
  if (raw === undefined || raw === null) return { ...base, state: "ok" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ...base,
      state: "broken",
      error: "toolPermissions in config.yaml is not a mapping.",
    };
  }
  for (const key of LIST_KEYS) {
    const list = raw[key];
    if (
      list !== undefined &&
      list !== null &&
      (!Array.isArray(list) || list.some((v) => typeof v !== "string"))
    ) {
      return {
        ...base,
        state: "broken",
        error: `toolPermissions.${key} in config.yaml must be a list of text entries.`,
      };
    }
  }
  return { ...base, state: "ok", permissions: sanitizeToolPermissions(raw) };
}

/** The person's own `toolPermissions`, read directly from their config.yaml. */
export function readUserToolPermissions(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): ToolPermissions | undefined {
  return readUserConfigFile(file).permissions;
}

/** The domains the person trusts, from their own config.yaml only. */
export function readUserTrustedDomains(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): string[] {
  return readUserToolPermissions(file)?.auto?.environment?.trustedDomains ?? [];
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
  const userFile = readUserConfigFile(
    options.configFile ?? path.join(global, "config.yaml"),
  );
  const user = userFile.permissions;
  const permissionsFile =
    options.permissionsFile ?? path.join(global, "permissions.yaml");
  const { settings, notices } = readPolicyFile(permissionsFile);
  const folder = options.withFolder === false ? [] : recordedFolderRules();
  const assistant = partitionMergedRules(
    options.merged,
    user,
    folder,
  ).assistant;
  // Allow rules the loader dropped (an assistant's), shown as ignored
  const droppedAllow = recordedAssistantAllows();
  const assistantWithDropped: ToolPermissions | undefined = droppedAllow.length
    ? {
        ...assistant,
        allow: [...(assistant?.allow ?? []), ...droppedAllow],
      }
    : assistant;
  return {
    user,
    userFile: {
      path: userFile.path,
      state: userFile.state,
      ...(userFile.error ? { error: userFile.error } : {}),
      ...(userFile.hash ? { hash: userFile.hash } : {}),
    },
    // The loader removes an assistant's allow rules, so one that is listed
    // here is shown as ignored, whatever the evaluator would do with it
    assistantAllow: "ignored",
    assistant: assistantWithDropped,
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
