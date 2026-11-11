/**
 * `continuous permissions add|remove|adopt`: change the rules in your own
 * config.yaml with the same validation, shadowing warnings and friction as the
 * Permissions page (core/tools/permissions/ruleEditor.ts). The core dialect
 * only, comments kept, a broken file refused, every change written to the
 * audit trail. A broad Always rule needs `--yes-allow-everything`; removing a
 * Never or moving a rule looser needs `--yes`.
 */

import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import type { AuditTrail } from "core/tools/permissions/audit/trail.js";
import {
  readRuleSources,
  readUserConfigFile,
  sanitizeToolPermissions,
} from "core/tools/permissions/readRuleSources.js";
import { CONFIRM_PHRASE } from "core/tools/permissions/ruleAnalysis.js";
import {
  editToolRule,
  type ToolRuleEdit,
  type ToolRuleEditResponse,
} from "core/tools/permissions/ruleEditor.js";
import type { RuleDecision } from "core/tools/permissions/rules.js";
import * as YAML from "yaml";

import { env } from "../env.js";
import { PERMISSIONS_YAML_PATH } from "../permissions/permissionsYamlLoader.js";

export interface PermissionsEditOptions {
  json?: boolean;
  configFile?: string;
  permissionsFile?: string;
  cwd?: string;
  /** remove, adopt: the list (never, ask, always; deny and allow also work) */
  decision?: string;
  /** adopt: the workspace or assistant file the rule is in */
  from?: string;
  yes?: boolean;
  yesAllowEverything?: boolean;
  dryRun?: boolean;
  /** A sample call to show what the rule changes */
  probe?: string;
  /** For tests: the trail the change is written to */
  audit?: AuditTrail;
}

export interface EditIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const ALIASES: Record<string, RuleDecision> = {
  never: "deny",
  deny: "deny",
  ask: "ask",
  always: "allow",
  allow: "allow",
};

const WORDS: Record<RuleDecision, string> = {
  deny: "Never",
  ask: "Ask",
  allow: "Always",
};

const DONE = ["added", "updated", "removed", "adopted"];

function decisionOf(raw: string | undefined): RuleDecision | undefined {
  return raw ? ALIASES[raw.toLowerCase()] : undefined;
}

function configFileOf(options: PermissionsEditOptions): string {
  return options.configFile ?? path.join(env.continueHome, "config.yaml");
}

type Folder = { file: string; permissions: Record<string, string[]> };

/** Exit code: 0 changed or previewed, 2 when a confirmation is missing, 1 otherwise. */
function printEdit(
  res: ToolRuleEditResponse,
  options: PermissionsEditOptions,
  io: EditIo,
): number {
  if (options.json) {
    io.out(JSON.stringify(res, null, 2));
  } else {
    for (const w of res.analysis?.warnings ?? []) {
      io.out(`warning: ${w.message}`);
    }
    if (res.verdict) {
      io.out(
        `For "${res.verdict.probe}": now ${res.verdict.before.decision.toUpperCase()}, with this rule ${res.verdict.after.decision.toUpperCase()}.`,
      );
    }
    for (const l of res.diff ?? []) {
      const mark = l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " ";
      io.out(`${mark} ${l.text}`);
    }
    if (res.error) io.err(res.error);
    if (res.result === "needs-confirmation") {
      io.err(
        res.analysis?.friction === "typed"
          ? "Run again with --yes-allow-everything to confirm."
          : "Run again with --yes to confirm.",
      );
    }
    if (DONE.includes(res.result)) io.out(`Done: ${res.result}.`);
    if (res.result === "preview") io.out("Nothing was written (dry run).");
    if (res.auditWritten === false) {
      io.err("Saved, but the change could not be written to the audit trail.");
    }
  }
  if (res.result === "needs-confirmation") return 2;
  return DONE.includes(res.result) || res.result === "preview" ? 0 : 1;
}

function run(
  edit: Omit<ToolRuleEdit, "source" | "confirm" | "dryRun">,
  options: PermissionsEditOptions,
  io: EditIo,
  folder?: Folder[],
): number {
  const file = configFileOf(options);
  const confirm = options.yesAllowEverything
    ? CONFIRM_PHRASE
    : options.yes
      ? "yes"
      : undefined;
  const res = editToolRule(
    {
      ...edit,
      source: "cli",
      ...(confirm ? { confirm } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.probe ? { probe: options.probe } : {}),
    },
    {
      file,
      sources: () => ({
        ...readRuleSources({
          configFile: file,
          permissionsFile: options.permissionsFile ?? PERMISSIONS_YAML_PATH,
          withFolder: false,
        }),
        ...(folder ? { folder } : {}),
      }),
      audit: options.audit ?? getAuditTrail(),
      home: os.homedir(),
      cwd: options.cwd ?? process.cwd(),
    },
  );
  return printEdit(res, options, io);
}

export function addCommand(
  args: string[],
  options: PermissionsEditOptions,
  io: EditIo,
): number {
  const decision = decisionOf(args[0]);
  const rule = args.slice(1).join(" ");
  if (!decision || !rule) {
    io.err(
      "Usage: continuous permissions add <never|ask|always> '<rule>' [--yes] [--yes-allow-everything] [--dry-run]\nExample: continuous permissions add ask 'runTerminalCommand(git push*)'",
    );
    return 1;
  }
  return run({ op: "add", decision, rule }, options, io);
}

export function removeCommand(
  args: string[],
  options: PermissionsEditOptions,
  io: EditIo,
): number {
  const rule = args.join(" ").trim();
  if (!rule) {
    io.err(
      "Usage: continuous permissions remove '<rule>' [--decision never|ask|always] [--yes]",
    );
    return 1;
  }
  let decision = decisionOf(options.decision);
  if (options.decision && !decision) {
    io.err(`--decision ${options.decision}: use never, ask or always`);
    return 1;
  }
  if (!decision) {
    const perms = readUserConfigFile(configFileOf(options)).permissions;
    const where = (["deny", "ask", "allow"] as RuleDecision[]).filter((d) =>
      (perms?.[d] ?? []).some((r) => r.trim() === rule),
    );
    if (where.length > 1) {
      io.err(
        `That rule is in more than one list (${where.map((d) => WORDS[d]).join(", ")}). Add --decision.`,
      );
      return 1;
    }
    decision = where[0] ?? "allow";
  }
  return run({ op: "remove", decision, rule }, options, io);
}

function readFromFile(file: string): Folder | string {
  try {
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) as any;
    const permissions = sanitizeToolPermissions(raw?.toolPermissions);
    if (!permissions) return `${file} has no toolPermissions rules.`;
    return { file, permissions: permissions as Record<string, string[]> };
  } catch (e) {
    return `Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function adoptCommand(
  args: string[],
  options: PermissionsEditOptions,
  io: EditIo,
): number {
  const rule = args.join(" ").trim();
  const decision = decisionOf(options.decision ?? "always");
  if (!rule || !options.from || !decision) {
    io.err(
      "Usage: continuous permissions adopt '<rule>' --from <file> [--decision never|ask|always] [--yes-allow-everything] [--dry-run]\nCopies a rule from a workspace or assistant file into your own config.yaml, after showing what it changes.",
    );
    return 1;
  }
  const from = readFromFile(options.from);
  if (typeof from === "string") {
    io.err(from);
    return 1;
  }
  return run({ op: "adopt", decision, rule }, options, io, [from]);
}
