import path from "node:path/posix";
import type { ToolPolicy } from "@continuedev/terminal-security";
import type { RuleSourcesInput } from "../effectiveRules";
import { canonicalRuleName, cleanPath, staysInside } from "../names";
import { findProtected } from "../protectedCall";
import { suggestAllowRule } from "../suggest";
import { describeAgent } from "./inbox";
import { maskText } from "./mask";
import type { AuditCallRow } from "./reader";
import {
  BLOCKING_SOURCES,
  classifyCommand,
  COMMAND_TAILS,
  commandHazard,
  type JudgeContext,
  judgeRule,
  overreach,
  PATH_NAMES,
  type Probe,
  type RiskClass,
} from "./suggestGuards";

/**
 * Rule suggestions from the audit trail (ROADMAP B9, Next 20 piece 18): asks
 * the person answered the same way again and again, as candidate rules in the
 * dialect the rule editor reads. Text only. Nothing here writes a rule: the
 * output names the `continuous permissions add` command, which goes through
 * the rule editor and its confirmation.
 *
 * What is never offered, and why it is listed under `withheld`:
 * - a call that a floor, a built-in ask rule, a protected path, a rule of the
 *   person's or the reviewer settled (an allow rule cannot loosen those, and a
 *   suggestion must not look as if it did): decided by running the real
 *   evaluator on the call with and without the rule;
 * - a row with a masked value, a call with a network host or a path outside
 *   the workspace, a command that writes or deletes, an MCP tool (its effect
 *   cannot be judged from the audit);
 * - a wildcard that would also allow a call it should not (`--output=/tmp/x`,
 *   a URL, `../`): so a command is offered exactly as the person approved it,
 *   `npm test` yes, `npm install *` and `npm test *` no. A directory glob is
 *   offered for plain files only, when three or more different files of one
 *   directory were allowed and `.env`, `.npmrc` and `id_rsa` stay unallowed.
 */
export interface SuggestOptions {
  /** Answers needed before a rule is suggested; default 3 */
  minCount?: number;
  /** Only allow or deny suggestions; default both */
  decision?: "allow" | "deny";
  cwd?: string;
  /** Different files of one directory before a directory glob; default 3 */
  minFiles?: number;
  /** The tool's own setting for the calls tested; the tool's default when absent */
  basePolicy?: ToolPolicy;
}

export interface RuleSuggestion {
  decision: "allow" | "deny";
  rule: string;
  tool: string;
  shape: "exact" | "directory";
  /** Times the person answered this way */
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Whole days from the first to the last answer */
  spanDays: number;
  agents: { name: string; count: number }[];
  risk: RiskClass;
  /** Up to three calls this rule would have settled, masked */
  examples: string[];
  /** The command that applies it, through the rule editor */
  apply: string;
}

export interface Withheld {
  subject: string;
  count: number;
  reason: string;
}

export interface SuggestResult {
  suggestions: RuleSuggestion[];
  withheld: Withheld[];
  /** Asks the person answered, before grouping */
  answered: number;
}

interface Call {
  row: AuditCallRow;
  tool: "runTerminalCommand" | "readFile" | "listDirectory";
  target: string;
  args: Record<string, unknown>;
}

const DAY = 86_400_000;

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function callOf(
  row: AuditCallRow,
): { call: Call } | { skip: string; subject: string } {
  const subject = row.tool;
  if (
    row.decisions.some((d) => d.maskedKinds?.length) ||
    row.argsMasked.includes("«masked:")
  ) {
    return { skip: "a value in the call was masked", subject };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.argsMasked);
  } catch {
    return { skip: "the arguments were cut short or unreadable", subject };
  }
  if (!args || typeof args !== "object") {
    return { skip: "the arguments were not readable", subject };
  }
  const tool = canonicalRuleName(row.tool);
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (tool === "runTerminalCommand" && s(args.command)) {
    return {
      call: {
        row,
        tool,
        target: (args.command as string).trim().replace(/\s+/g, " "),
        args,
      },
    };
  }
  const file = tool === "readFile" ? s(args.filepath) : s(args.dirPath);
  if ((tool === "readFile" || tool === "listDirectory") && file) {
    return { call: { row, tool, target: cleanPath(file), args } };
  }
  return {
    skip: tool.startsWith("mcp__")
      ? "an MCP tool's effect cannot be judged from the audit"
      : "this kind of call is not read for suggestions",
    subject,
  };
}

function summarise(
  calls: Call[],
  decision: "allow" | "deny",
  rule: string,
  tool: string,
  shape: RuleSuggestion["shape"],
  risk: RiskClass,
): RuleSuggestion {
  const times = calls.map((c) => Date.parse(c.row.ts)).sort((a, b) => a - b);
  const byAgent = new Map<string, number>();
  for (const c of calls) {
    const name = describeAgent(c.row.agent).replace(/ under .*$/, "");
    byAgent.set(name, (byAgent.get(name) ?? 0) + 1);
  }
  const stamps = calls.map((c) => c.row.ts).sort();
  const word = decision === "allow" ? "always" : "never";
  return {
    decision,
    rule,
    tool,
    shape,
    count: calls.length,
    firstSeen: stamps[0],
    lastSeen: stamps[stamps.length - 1],
    spanDays: Math.floor((times[times.length - 1] - times[0]) / DAY),
    agents: [...byAgent]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    risk,
    examples: [...new Set(calls.map((c) => maskText(c.target).text))].slice(
      0,
      3,
    ),
    apply: `continuous permissions add ${word} ${shellQuote(rule)}`,
  };
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const list = out.get(k);
    if (list) list.push(i);
    else out.set(k, [i]);
  }
  return out;
}

function prefixOf(command: string): string {
  const words = command.split(" ");
  const sub = words[1] && !words[1].startsWith("-") ? 2 : 1;
  return words.length > sub ? words.slice(0, sub).join(" ") : "";
}

class Suggester {
  readonly suggestions: RuleSuggestion[] = [];
  readonly withheld: Withheld[] = [];
  readonly min: number;
  readonly minFiles: number;
  readonly ctx: JudgeContext;

  constructor(sources: RuleSourcesInput, opts: SuggestOptions) {
    this.ctx = { sources, cwd: opts.cwd, basePolicy: opts.basePolicy };
    this.min = opts.minCount ?? 3;
    this.minFiles = opts.minFiles ?? 3;
  }

  hold(subject: string, count: number, reason: string): void {
    this.withheld.push({ subject: maskText(subject).text, count, reason });
  }

  /** A protected path is never suggested, allow or deny. */
  private protectedReason(c: Call): string | undefined {
    const hit = findProtected({ toolName: c.row.tool, parsedArgs: c.args });
    return hit ? `${hit.path} is a protected path` : undefined;
  }

  /** Why an allow must not be offered for a call, with its risk class. */
  private allowHazard(c: Call): { reason?: string; risk: RiskClass } {
    if (c.row.source && BLOCKING_SOURCES.has(c.row.source)) {
      return {
        reason: `it asked because of ${c.row.source}, which an allow rule does not override`,
        risk: { kind: "n/a", risk: "high", why: "" },
      };
    }
    if (c.tool === "runTerminalCommand") {
      const risk = classifyCommand(c.target);
      if (
        ["network", "deletes", "writes-files", "unclassified"].includes(
          risk.kind,
        )
      ) {
        return { reason: risk.why, risk };
      }
      return { reason: commandHazard(c.target), risk };
    }
    return {
      ...(staysInside(c.target)
        ? {}
        : { reason: "the path is outside the workspace" }),
      risk: {
        kind: "read-only",
        risk: "low",
        why: "it reads files inside the workspace",
      },
    };
  }

  exact(calls: Call[], decision: "allow" | "deny"): void {
    const first = calls[0];
    const subject = `${first.tool} ${first.target}`;
    const protectedWhy = this.protectedReason(first);
    if (protectedWhy) return this.hold(subject, calls.length, protectedWhy);
    let risk: RiskClass;
    if (decision === "allow") {
      const h = this.allowHazard(first);
      if (h.reason) return this.hold(subject, calls.length, h.reason);
      risk = h.risk;
    } else {
      risk =
        first.tool === "runTerminalCommand"
          ? classifyCommand(first.target)
          : { kind: "read-only", risk: "low", why: "it reads files" };
    }
    // The rule the "Always allow" button would write, or its Never twin
    const base = suggestAllowRule({
      toolName: first.row.tool,
      parsedArgs: first.args,
    });
    if (!base.ok) return this.hold(subject, calls.length, base.reason);
    const probe: Probe = {
      tool: first.tool,
      field: first.tool === "runTerminalCommand" ? "command" : "path",
      value: first.target,
    };
    const verdict = judgeRule(probe, decision, base.rule, this.ctx);
    if (!verdict.ok) return this.hold(subject, calls.length, verdict.reason);
    this.suggestions.push(
      summarise(calls, decision, base.rule, first.tool, "exact", risk),
    );
  }

  /** Several files of one directory allowed: one glob, if it admits nothing it should not. */
  directory(dir: string, tool: Call["tool"], calls: Call[]): boolean {
    const rule = `${tool}(${dir}/*)`;
    const subject = `${tool} ${dir}/*`;
    if (new Set(calls.map((c) => c.target)).size < this.minFiles) return false;
    if (calls.length < this.min || /[()*?]/.test(dir)) return false;
    if (
      calls.some((c) => this.allowHazard(c).reason || this.protectedReason(c))
    ) {
      return false;
    }
    const probes: Probe[] = PATH_NAMES.map((n) => ({
      tool,
      field: "path",
      value: `${dir}/${n}`,
    }));
    const wide = overreach(probes, rule, this.ctx);
    if (wide) {
      this.hold(subject, calls.length, `it would also allow ${wide.value}`);
      return false;
    }
    for (const c of calls) {
      const v = judgeRule(
        { tool, field: "path", value: c.target },
        "allow",
        rule,
        this.ctx,
      );
      if (!v.ok) {
        this.hold(subject, calls.length, v.reason);
        return false;
      }
    }
    this.suggestions.push(
      summarise(calls, "allow", rule, tool, "directory", {
        kind: "read-only",
        risk: "low",
        why: `it reads plain files of ${dir}; .env, .npmrc and id_rsa stay protected`,
      }),
    );
    return true;
  }

  /** A command wildcard is tried and, if it admits what it should not, reported and dropped. */
  wildcard(calls: Call[]): void {
    for (const [prefix, list] of group(calls, (c) => prefixOf(c.target))) {
      const tails = new Set(list.map((c) => c.target));
      if (!prefix || tails.size < 2 || list.length < this.min) continue;
      const probes: Probe[] = COMMAND_TAILS.map((t) => ({
        tool: "runTerminalCommand",
        field: "command",
        value: `${prefix} ${t}`,
      }));
      const wide = overreach(
        probes,
        `runTerminalCommand(${prefix} *)`,
        this.ctx,
      );
      this.hold(
        `${prefix} <anything>`,
        list.length,
        wide
          ? `a wildcard would also allow \`${wide.value}\`, so only the exact commands are offered`
          : "a wildcard for a command is not offered",
      );
    }
  }
}

/** Suggestions from the call rows of the trail; the rows should already be bounded. */
export function suggestRules(
  rows: readonly AuditCallRow[],
  sources: RuleSourcesInput,
  opts: SuggestOptions = {},
): SuggestResult {
  const s = new Suggester(sources, opts);
  const answered = rows.filter(
    (r) =>
      r.asked &&
      r.by === "person" &&
      (r.policy === "allow" || r.policy === "deny"),
  );
  const calls: Call[] = [];
  const skipped = new Map<
    string,
    { n: number; reason: string; subject: string }
  >();
  for (const row of answered) {
    const r = callOf(row);
    if ("call" in r) {
      calls.push(r.call);
      continue;
    }
    const k = `${r.subject}|${r.skip}`;
    const cur = skipped.get(k) ?? { n: 0, reason: r.skip, subject: r.subject };
    cur.n++;
    skipped.set(k, cur);
  }
  for (const v of skipped.values()) s.hold(v.subject, v.n, v.reason);

  const want = (d: "allow" | "deny") => !opts.decision || opts.decision === d;
  const allowFiles: Call[] = [];
  for (const list of group(
    calls,
    (c) => `${c.tool}\u0000${c.target}`,
  ).values()) {
    const first = list[0];
    const allows = list.filter((c) => c.row.policy === "allow").length;
    if (allows && allows < list.length) {
      s.hold(
        `${first.tool} ${first.target}`,
        list.length,
        "it was answered both allow and deny",
      );
      continue;
    }
    const decision = allows ? "allow" : "deny";
    if (!want(decision)) continue;
    // Files asked a few times each may still add up to a directory
    if (decision === "allow" && first.tool !== "runTerminalCommand") {
      allowFiles.push(...list);
    } else if (list.length >= s.min) {
      s.exact(list, decision);
    }
  }
  const byDir = group(
    allowFiles,
    (c) => `${c.tool}\u0000${path.dirname(c.target)}`,
  );
  for (const dirCalls of byDir.values()) {
    const { tool, target } = dirCalls[0];
    const dir = path.dirname(target);
    if (dir !== "." && s.directory(dir, tool, dirCalls)) continue;
    for (const list of group(dirCalls, (c) => c.target).values()) {
      if (list.length >= s.min) s.exact(list, "allow");
    }
  }
  if (want("allow")) {
    s.wildcard(
      calls.filter(
        (c) => c.tool === "runTerminalCommand" && c.row.policy === "allow",
      ),
    );
  }
  s.suggestions.sort(
    (a, b) => b.count - a.count || a.rule.localeCompare(b.rule),
  );
  return {
    suggestions: s.suggestions,
    withheld: s.withheld,
    answered: answered.length,
  };
}
