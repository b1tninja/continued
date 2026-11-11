import { canonicalRuleName } from "./names";
import { parseRule, globMatch, type RuleDecision } from "./rules";
import { CONFIRM_PHRASE, DECISION_WORDS } from "./ruleWords";

/**
 * What the rule editor says about a rule before it is saved (plans/rule-editor.md,
 * slice 2). Pure: no files, no home directory lookup (the caller passes it), so
 * the Permissions page, the CLI and the tests all get the same answer.
 *
 * Words: Never is `deny`, Ask is `ask` and Always is `allow` (ruleWords.ts).
 */
export { CONFIRM_PHRASE, DECISION_WORDS };

/** Where a rule change came from, for the audit trail. */
export type ChangeSource = "permissions-page" | "cli" | "always-allow-button";

export type Friction =
  /** No confirmation needed */
  | "none"
  /** One explicit confirmation (removing a Never, loosening a rule) */
  | "confirm"
  /** The CONFIRM_PHRASE has to be typed (a rule that allows everything or a broad wildcard) */
  | "typed";

export interface RuleWarning {
  kind:
    | "duplicate"
    | "also-listed"
    | "shadowed"
    | "carved-out"
    | "dead"
    | "broad"
    | "unknown-tool"
    | "never-matches";
  /** A sentence a person reads */
  message: string;
  /** The other rule involved, when there is one */
  other?: string;
}

export interface RuleAnalysis {
  /** The rule is written in a form the engine can read */
  valid: boolean;
  /** Why not, when it is not valid */
  error?: string;
  /** The rule with surrounding space removed, as it would be written */
  rule: string;
  /** Needs the typed phrase because it allows everything or a broad wildcard */
  broad: boolean;
  /** Plain words for why, when `broad` */
  broadReason?: string;
  friction: Friction;
  /** The change lets something run that did not before (a new Always, a removed Never or Ask) */
  loosens: boolean;
  warnings: RuleWarning[];
}

/** A rule other than the one being changed, for shadowing and duplicate checks. */
export interface PeerRule {
  decision: RuleDecision;
  raw: string;
  /** Names the owner for the message: "your rule", "a workspace rule", "a floor rule" */
  owner: string;
  /** A rule that does not loosen anything is still weighed; ignored ones are not */
  ignored?: boolean;
}

export const MAX_RULE_CHARS = 500;

/**
 * Text that cannot be a rule: control characters and the invisible
 * direction marks that make a rule read differently from how it matches.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

/** Is this text safe to write as one entry of a YAML list, and readable by the engine? */
export function validateRuleText(
  rule: string,
  decision: RuleDecision,
): string | undefined {
  if (typeof rule !== "string" || rule.trim() === "") {
    return "Write a rule as toolName(pattern), or just toolName.";
  }
  if (rule.length > MAX_RULE_CHARS) {
    return `A rule is at most ${MAX_RULE_CHARS} characters.`;
  }
  if (UNSAFE_CHARS.test(rule)) {
    return "A rule cannot hold control or invisible characters.";
  }
  if (!parseRule(rule.trim(), decision)) {
    return "Write a rule as toolName(pattern), or just toolName. A pattern in brackets cannot be empty.";
  }
  return undefined;
}

const FILE_TOOLS = new Set([
  "readFile",
  "writeFile",
  "listDirectory",
  "grepSearch",
  "globSearch",
]);

/** Commands that run whatever follows them, so a rule that allows them allows anything. */
const WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "env",
  "sudo",
  "doas",
  "xargs",
  "eval",
  "exec",
  "nohup",
  "time",
  "timeout",
  "watch",
  "powershell",
  "pwsh",
  "cmd",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "ssh",
]);

/** Folders whose contents are credentials: a rule that reaches them needs the phrase. */
const CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];

const norm = (p: string) => p.replace(/\\/g, "/");

/** Where a path pattern's literal part ends: everything before the first wildcard. */
function literalBase(pattern: string): { base: string; wild: boolean } {
  const p = norm(pattern.trim());
  const i = p.search(/[*?[{]/);
  if (i < 0) return { base: p.replace(/\/+$/, ""), wild: false };
  return { base: p.slice(0, i).replace(/\/+$/, ""), wild: true };
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}${p.slice(1)}`;
  return p;
}

const lower = (s: string) => s.toLowerCase();

function pathBroadReason(pattern: string, home: string): string | undefined {
  const { base, wild } = literalBase(pattern);
  const h = norm(home).replace(/\/+$/, "");
  if (wild && base === "") {
    return "It matches every path, in any folder.";
  }
  if (base === "" && !wild) return undefined;
  const full = norm(expandHome(base, h));
  if (full === "" || /^[a-z]:$/i.test(full) || full === "/") {
    return "It covers the whole disk.";
  }
  const fl = lower(full);
  const hl = lower(h);
  // Every path under the home folder, or a folder that holds it
  if (wild && h && (fl === hl || hl.startsWith(`${fl}/`))) {
    return "It covers your whole home folder.";
  }
  if (!wild && h && fl === hl) return "It names your home folder.";
  for (const dir of CREDENTIAL_DIRS) {
    const sensitive = `${hl}/${dir}`;
    if (
      fl === sensitive ||
      fl.startsWith(`${sensitive}/`) ||
      // a pattern above it that reaches it
      (wild && sensitive.startsWith(`${fl}/`))
    ) {
      return `It reaches ~/${dir}, where credentials are kept.`;
    }
  }
  return undefined;
}

function commandBroadReason(pattern: string): string | undefined {
  const p = pattern.trim();
  if (/^[*\s]+$/.test(p)) return "It matches every command.";
  const first = p.split(/\s+/)[0] ?? "";
  if (first.includes("*")) {
    return "The first word of the command is a wildcard, so it matches commands you did not mean.";
  }
  const word = first.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  if (WRAPPERS.has(lower(word))) {
    return `"${word}" runs whatever follows it, so allowing it allows any command.`;
  }
  return undefined;
}

function fetchBroadReason(pattern: string): string | undefined {
  const p = pattern.trim();
  if (/^[*\s]+$/.test(p)) return "It matches every address.";
  const rest = p.replace(/^[a-z*]+:\/\//i, "");
  if (rest === "" || rest.startsWith("*")) {
    return "The host is a wildcard, so it matches every site.";
  }
  return undefined;
}

/**
 * Why an Always rule is broad enough to need the typed phrase, or undefined.
 * Broad: a bare tool name (it matches every call to that tool); `**` or `*`
 * as the pattern; an MCP rule with a wildcard server; a command rule whose
 * first word is a wildcard or an interpreter; a path rule that covers `/`,
 * the home folder or a credentials folder; a fetch rule with a wildcard host.
 * Never and Ask rules are never broad: a wide Never only protects.
 */
export function broadReason(
  decision: RuleDecision,
  rule: string,
  home: string,
): string | undefined {
  if (decision !== "allow") return undefined;
  const parsed = parseRule(rule.trim(), "allow");
  if (!parsed) return undefined;
  const name = canonicalRuleName(parsed.toolName);
  if (parsed.toolName.startsWith("mcp__")) {
    const server = parsed.toolName.split("__")[1] ?? "";
    if (server === "" || server.includes("*")) {
      return "It allows the tools of every MCP server.";
    }
    return undefined;
  }
  if (parsed.pattern === undefined) {
    return `It allows every call to ${parsed.toolName}, whatever it is given.`;
  }
  const pattern = parsed.pattern;
  if (name === "runTerminalCommand") return commandBroadReason(pattern);
  if (name === "fetchUrl") return fetchBroadReason(pattern);
  if (FILE_TOOLS.has(name)) return pathBroadReason(pattern, home);
  return /^[*\s]+$/.test(pattern.trim())
    ? "The pattern matches everything."
    : undefined;
}

/** The patterns of two rules for the same tool, or undefined when the tools differ. */
function samePattern(
  a: string,
  b: string,
): { tool: string; pa?: string; pb?: string } | undefined {
  const pa = parseRule(a, "allow");
  const pb = parseRule(b, "allow");
  if (!pa || !pb) return undefined;
  const ta = canonicalRuleName(pa.toolName);
  const tb = canonicalRuleName(pb.toolName);
  if (ta !== tb && !(pa.toolName.includes("*") || pb.toolName.includes("*"))) {
    return undefined;
  }
  if (ta !== tb) {
    // MCP name patterns: `mcp__github__*` against `mcp__github__create_issue`
    if (
      !globMatch(pa.toolName, pb.toolName) &&
      !globMatch(pb.toolName, pa.toolName)
    ) {
      return undefined;
    }
  }
  return { tool: ta, pa: pa.pattern, pb: pb.pattern };
}

/** `outer` covers every call `inner` matches (approximated on the patterns' text). */
function covers(outer: string, inner: string): boolean | "part" {
  const m = samePattern(outer, inner);
  if (!m) return false;
  if (m.pa === undefined) return true; // a bare tool name covers every call
  if (m.pb === undefined) return false;
  if (globMatch(m.pa, m.pb)) return true;
  // The other way round: the inner rule is wider, so the outer one cuts a part out of it
  const sample = m.pa.replace(/\*+/g, "x");
  if (globMatch(m.pb, sample)) return "part";
  return false;
}

export interface AnalyzeInput {
  decision: RuleDecision;
  rule: string;
  /** The rule this one replaces (an edit or a move), left out of the comparisons */
  replaces?: { decision: RuleDecision; rule: string };
  /** Every other rule in effect that could interact with it */
  peers: PeerRule[];
  home: string;
}

/** Shadowing, duplicates and the other warnings for one rule against the rest. */
export function warningsFor(input: AnalyzeInput): RuleWarning[] {
  const rule = input.rule.trim();
  const out: RuleWarning[] = [];
  const peers = input.peers.filter(
    (p) =>
      !(
        input.replaces &&
        p.decision === input.replaces.decision &&
        p.raw === input.replaces.rule &&
        p.owner === "your rule"
      ),
  );
  for (const p of peers) {
    if (
      p.raw === rule &&
      p.decision === input.decision &&
      p.owner === "your rule"
    ) {
      out.push({
        kind: "duplicate",
        message: `You already have this rule in ${DECISION_WORDS[p.decision]}.`,
        other: p.raw,
      });
      continue;
    }
    if (p.raw === rule && p.decision !== input.decision) {
      out.push({
        kind: "also-listed",
        message: `${p.owner[0].toUpperCase()}${p.owner.slice(1)} ${p.raw} says ${DECISION_WORDS[p.decision]} for the same calls. ${
          p.decision === "deny" ||
          (p.decision === "ask" && input.decision === "allow")
            ? `${DECISION_WORDS[p.decision]} wins, so this rule will not take effect.`
            : "The stricter one wins."
        }`,
        other: p.raw,
      });
    }
  }
  if (input.decision === "allow") {
    for (const p of peers) {
      if (p.decision === "allow" || p.ignored) continue;
      const c = covers(p.raw, rule);
      if (c === true && p.raw !== rule) {
        out.push({
          kind: "shadowed",
          message: `${DECISION_WORDS[p.decision]} rule ${p.raw} (${p.owner}) covers everything this rule allows, so it can never take effect: ${DECISION_WORDS[p.decision]} beats Always whatever the order.`,
          other: p.raw,
        });
      } else if (c === "part") {
        out.push({
          kind: "carved-out",
          message: `${DECISION_WORDS[p.decision]} rule ${p.raw} (${p.owner}) is more specific, so calls it matches will ${p.decision === "deny" ? "be refused" : "still ask"} even though this rule allows the rest.`,
          other: p.raw,
        });
      }
    }
  } else {
    // A new Never or Ask makes an Always rule of yours dead or partly dead
    for (const p of peers) {
      if (p.decision !== "allow" || p.owner !== "your rule") continue;
      const c = covers(rule, p.raw);
      if (c === true) {
        out.push({
          kind: "dead",
          message: `This ${DECISION_WORDS[input.decision]} rule covers everything your Always rule ${p.raw} allows, so that rule will stop taking effect.`,
          other: p.raw,
        });
      } else if (c === "part") {
        out.push({
          kind: "carved-out",
          message: `This ${DECISION_WORDS[input.decision]} rule takes some calls out of your Always rule ${p.raw}.`,
          other: p.raw,
        });
      }
    }
  }
  return out;
}

/**
 * Everything the editor says about one change: whether the text is a rule, how
 * much friction it needs, whether it loosens, and the warnings.
 */
export function analyzeRule(
  input: AnalyzeInput & { removing?: boolean },
): RuleAnalysis {
  const rule = input.rule.trim();
  const error = validateRuleText(input.rule, input.decision);
  if (error) {
    return {
      valid: false,
      error,
      rule,
      broad: false,
      friction: "none",
      loosens: false,
      warnings: [],
    };
  }
  if (input.removing) {
    // Taking a rule away: a Never or Ask going loosens, an Always going tightens
    const loosensNow = input.decision !== "allow";
    return {
      valid: true,
      rule,
      broad: false,
      friction: loosensNow ? "confirm" : "none",
      loosens: loosensNow,
      warnings: [],
    };
  }
  const broad = broadReason(input.decision, rule, input.home);
  const warnings = warningsFor(input);
  if (broad) warnings.unshift({ kind: "broad", message: broad });
  const rank: Record<RuleDecision, number> = { deny: 0, ask: 1, allow: 2 };
  const movesLooser =
    input.replaces !== undefined &&
    rank[input.decision] > rank[input.replaces.decision];
  // A new Always loosens, but is only a plain save unless it is broad
  const loosens = input.decision === "allow" || movesLooser;
  return {
    valid: true,
    rule,
    broad: Boolean(broad),
    ...(broad ? { broadReason: broad } : {}),
    friction: broad ? "typed" : movesLooser ? "confirm" : "none",
    loosens,
    warnings,
  };
}

/** True when the confirmation given is enough for the friction the change needs. */
export function confirmationEnough(
  friction: Friction,
  confirm: string | undefined,
): boolean {
  if (friction === "none") return true;
  const c = (confirm ?? "").trim().toLowerCase();
  if (friction === "typed") return c === CONFIRM_PHRASE;
  return c === "yes" || c === CONFIRM_PHRASE;
}

/** One line of a diff between two texts. */
export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/**
 * A line diff of two texts with `context` unchanged lines around each change.
 * Small files only (config.yaml): a simple longest-common-subsequence table,
 * and past 4000 lines the changed lines are listed without context.
 */
export function lineDiff(
  before: string,
  after: string,
  context = 2,
): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out: DiffLine[] = [];
  if (a.length * b.length > 4000 * 4000) {
    const as = new Set(a);
    const bs = new Set(b);
    for (const l of a) if (!bs.has(l)) out.push({ kind: "remove", text: l });
    for (const l of b) if (!as.has(l)) out.push({ kind: "add", text: l });
    return out;
  }
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] =
        a[i] === b[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) {
      all.push({ kind: "remove", text: a[i++] });
    } else {
      all.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) all.push({ kind: "remove", text: a[i++] });
  while (j < m) all.push({ kind: "add", text: b[j++] });
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.kind === "same") return;
    for (
      let x = Math.max(0, k - context);
      x <= Math.min(all.length - 1, k + context);
      x++
    ) {
      keep[x] = true;
    }
  });
  return all.filter((_, k) => keep[k]);
}
