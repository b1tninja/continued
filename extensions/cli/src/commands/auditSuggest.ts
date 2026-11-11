/**
 * `continuous audit suggest`: candidate rules from the asks the person
 * answered the same way again and again (ROADMAP B9, Next 20 piece 18). It
 * reads the audit trail within limits, prints text, and applies nothing: each
 * suggestion names the `continuous permissions add` command that would, which
 * goes through the rule editor and its confirmation.
 */

import path from "node:path";

import type { Command } from "commander";
import {
  auditDir,
  auditSettings,
} from "core/tools/permissions/audit/global.js";
import { maskText } from "core/tools/permissions/audit/mask.js";
import {
  DEFAULT_READ_LIMITS,
  listCallsBounded,
  type ReadStats,
} from "core/tools/permissions/audit/reader.js";
import {
  suggestRules,
  type RuleSuggestion,
  type SuggestResult,
} from "core/tools/permissions/audit/suggestRules.js";
import { readRuleSources } from "core/tools/permissions/readRuleSources.js";

import { env } from "../env.js";
import { PERMISSIONS_YAML_PATH } from "../permissions/permissionsYamlLoader.js";

export interface AuditSuggestOptions {
  json?: boolean;
  /** Answers needed before a rule is suggested */
  min?: string | number;
  /** allow or deny */
  decision?: string;
  /** Read at most this many days back, and this many megabytes and records */
  maxAgeDays?: string | number;
  maxMb?: string | number;
  maxRows?: string | number;
  /** Also list what was not suggested, and why */
  verbose?: boolean;
  dir?: string;
  configFile?: string;
  permissionsFile?: string;
  cwd?: string;
}

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function render(
  result: SuggestResult,
  stats: ReadStats,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  const cut = stats.truncatedBy
    ? ` The read stopped at its ${stats.truncatedBy} limit, so older records were not counted.`
    : "";
  lines.push(
    `Read ${stats.records} records from ${stats.filesRead} of ${stats.filesSeen} files (${(stats.bytesRead / 1048576).toFixed(1)} MB); ${result.answered} asks you answered.${cut}`,
  );
  if (result.suggestions.length === 0) {
    lines.push("No rule is suggested.");
  }
  result.suggestions.forEach((s: RuleSuggestion, i: number) => {
    const agents = s.agents.map((a) => `${a.name} ${a.count}`).join(", ");
    lines.push(
      "",
      `${i + 1}. ${s.decision === "allow" ? "ALWAYS" : "NEVER"}  ${s.rule}`,
      `   ${s.decision === "allow" ? "allowed" : "refused"} ${s.count} times, ${s.firstSeen.slice(0, 10)} to ${s.lastSeen.slice(0, 10)} (${s.spanDays} days); agents: ${agents}`,
      `   risk: ${s.risk.risk} (${s.risk.kind}: ${s.risk.why})`,
      ...s.examples.map((e) => `   e.g. ${e}`),
      `   apply: ${s.apply}`,
    );
  });
  if (verbose) {
    lines.push("", `Not suggested (${result.withheld.length}):`);
    for (const w of result.withheld) {
      lines.push(`   ${w.subject} (${w.count}): ${w.reason}`);
    }
  } else if (result.withheld.length) {
    lines.push(
      "",
      `${result.withheld.length} candidate(s) were not suggested; --verbose says why.`,
    );
  }
  lines.push("", "Nothing was changed. Applying a rule asks you to confirm.");
  return lines;
}

/** Returns the process exit code. */
export function auditSuggestCommand(
  options: AuditSuggestOptions = {},
  io: { out?: (line: string) => void; err?: (line: string) => void } = {},
): number {
  // Masked again on the way out: a record written by something else may not be
  const out =
    io.out ?? ((line) => process.stdout.write(`${maskText(line).text}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  if (options.decision && !["allow", "deny"].includes(options.decision)) {
    err("--decision must be allow or deny.");
    return 2;
  }
  const dir = options.dir ?? auditDir();
  const { rows, stats } = listCallsBounded(
    dir,
    {},
    {
      maxAgeDays:
        num(options.maxAgeDays) ??
        Math.max(auditSettings().retentionDays, DEFAULT_READ_LIMITS.maxAgeDays),
      maxBytes: num(options.maxMb)
        ? Math.floor(num(options.maxMb)! * 1048576)
        : undefined,
      maxRows: num(options.maxRows),
    },
  );
  const sources = readRuleSources({
    configFile:
      options.configFile ?? path.join(env.continueHome, "config.yaml"),
    permissionsFile: options.permissionsFile ?? PERMISSIONS_YAML_PATH,
    withFolder: false,
  });
  const result = suggestRules(rows, sources, {
    minCount: num(options.min),
    decision: options.decision as "allow" | "deny" | undefined,
    cwd: options.cwd ?? process.cwd(),
  });
  if (options.json) {
    out(JSON.stringify({ stats, ...result }));
    return 0;
  }
  for (const line of render(result, stats, options.verbose === true)) {
    out(line);
  }
  return 0;
}

/** The options of `audit suggest`, kept here so index.ts does not grow. */
export function addAuditSuggestOptions(command: Command): Command {
  return command
    .option("--min <n>", "suggest: answers needed before a rule is suggested")
    .option("--max-age-days <n>", "suggest: read at most this many days back")
    .option("--max-mb <n>", "suggest: read at most this many megabytes")
    .option("--max-rows <n>", "suggest: read at most this many records")
    .option("--verbose", "suggest: also say what was not suggested, and why");
}
