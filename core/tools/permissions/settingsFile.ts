import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  BUILTIN_RULES,
  DEFAULT_POLICY_LEVELS,
  normalizePolicy,
  POLICY_AREAS,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevels,
  type PolicySettings,
  type QuestionDelivery,
} from "./policy.js";

/**
 * The one settings file the IDE and the CLI both read: permissions.yaml in the
 * global directory (plans/policy-areas.md, "Settings"). It shares the file
 * with the CLI's own `allow`, `ask` and `exclude` lists, which this module
 * never touches.
 *
 * YOLO and IDGAF are session-only: a saved `yolo` is read as that area's
 * default with a notice, and is never written.
 */
export interface PolicyFileSettings extends PolicySettings {
  /** Deny rules that bind at every level, YOLO included. */
  floor?: string[];
  /** MCP servers whose read-only hints the person trusts, by display name. */
  mcpServers?: Record<string, "trusted">;
}

export interface PolicyFileRead {
  settings: PolicyFileSettings;
  /** One line per value that could not be used or was changed on read. */
  notices: string[];
}

/** The keys of the file this module owns. The rest belongs to the CLI. */
export const POLICY_FILE_KEYS = [
  "levels",
  "plan",
  "questions",
  "builtin",
  "floor",
  "mcpServers",
  "sandbox",
] as const;

const BUILTIN_IDS = new Set<string>(BUILTIN_RULES.map((r) => r.id));

function asBool(value: unknown): boolean | undefined {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return undefined;
}

/** Settings from the file's text. A missing or unreadable file is the defaults. */
export function parsePolicyFile(text: string | undefined): PolicyFileRead {
  const notices: string[] = [];
  let raw: Record<string, any> = {};
  if (text?.trim()) {
    try {
      const parsed = YAML.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed;
      } else {
        notices.push("permissions.yaml is not a mapping, so it was ignored.");
      }
    } catch (e) {
      notices.push(
        `permissions.yaml could not be read (${e instanceof Error ? e.message : String(e)}), so the defaults apply.`,
      );
    }
  }

  // YOLO is never read from disk
  const levelsIn: Record<string, unknown> = { ...(raw.levels ?? {}) };
  for (const area of POLICY_AREAS) {
    if (levelsIn[area] === "yolo") {
      delete levelsIn[area];
      notices.push(
        `levels.${area}: yolo is for one session only, so ${DEFAULT_POLICY_LEVELS[area]} applies.`,
      );
    }
  }

  const { policy, problems } = normalizePolicy({
    levels: levelsIn,
    maxNewPlanItems: raw.plan?.maxNewItems,
    questions: {
      delivery: raw.questions?.delivery,
      youDecide: raw.questions?.youDecide,
      agentDecides: raw.questions?.agentDecides,
    },
  });
  notices.push(...problems.map((p) => `permissions.yaml: ${p}`));

  const settings: PolicyFileSettings = { ...policy };
  if (raw.builtin && typeof raw.builtin === "object") {
    const builtin: Partial<Record<BuiltinRuleId, boolean>> = {};
    for (const [id, value] of Object.entries(raw.builtin)) {
      const on = asBool(value);
      if (!BUILTIN_IDS.has(id)) {
        notices.push(`builtin.${id}: there is no built-in rule with that id.`);
      } else if (on === undefined) {
        notices.push(`builtin.${id}: use on or off.`);
      } else {
        builtin[id as BuiltinRuleId] = on;
      }
    }
    settings.builtin = builtin;
  }
  if (Array.isArray(raw.floor)) {
    settings.floor = raw.floor.filter((r: unknown) => typeof r === "string");
  }
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    const servers: Record<string, "trusted"> = {};
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (value === "trusted") servers[name] = "trusted";
    }
    settings.mcpServers = servers;
  }
  return { settings, notices };
}

/** What `save` is given: the parts of the settings a person can change. */
export interface PolicyFileUpdate {
  levels?: PolicyLevels;
  maxNewPlanItems?: number;
  questions?: {
    delivery?: QuestionDelivery;
    youDecide?: string[];
    agentDecides?: string[];
  };
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
}

/**
 * The file's text with the update applied, keeping every other key and
 * comment. Levels at YOLO are not written: the area keeps what the file had.
 */
export function applyPolicyUpdate(
  text: string | undefined,
  update: PolicyFileUpdate,
): string {
  const doc = YAML.parseDocument(text?.trim() ? text : "{}");
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any;

  if (update.levels) {
    for (const area of POLICY_AREAS as readonly PolicyArea[]) {
      const level = update.levels[area];
      if (level === "yolo") continue;
      doc.setIn(["levels", area], level);
    }
  }
  if (update.maxNewPlanItems !== undefined) {
    doc.setIn(["plan", "maxNewItems"], update.maxNewPlanItems);
  }
  if (update.questions?.delivery) {
    doc.setIn(["questions", "delivery"], update.questions.delivery);
  }
  if (update.questions?.youDecide) {
    doc.setIn(["questions", "youDecide"], update.questions.youDecide);
  }
  if (update.questions?.agentDecides) {
    doc.setIn(["questions", "agentDecides"], update.questions.agentDecides);
  }
  if (update.builtin) {
    for (const [id, on] of Object.entries(update.builtin)) {
      if (!BUILTIN_IDS.has(id)) continue;
      // Stored as a switch by id, and only when off: absent means on
      if (on === false) doc.setIn(["builtin", id], "off");
      else doc.deleteIn(["builtin", id]);
    }
    const builtin = doc.get("builtin") as YAML.YAMLMap | undefined;
    if (builtin && builtin.items.length === 0) doc.delete("builtin");
  }
  return String(doc);
}

export function readPolicyFile(file: string): PolicyFileRead {
  try {
    return parsePolicyFile(fs.readFileSync(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return parsePolicyFile(undefined);
    return {
      settings: parsePolicyFile(undefined).settings,
      notices: [`permissions.yaml could not be read: ${e?.message ?? e}`],
    };
  }
}

export function writePolicyFile(file: string, update: PolicyFileUpdate): void {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, applyPolicyUpdate(existing, update), "utf-8");
}
