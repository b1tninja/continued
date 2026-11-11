/**
 * `scanText` and `redact`: one rule set, two profiles.
 *
 * - `at-rest`: recall first. Every rule runs, including contextual and
 *   entropy rules. For captures, fixtures, datasets, result files, the audit
 *   trail: places where a false positive costs a review and a miss costs a
 *   leak.
 * - `outbound`: precision first. Only `high` confidence rules and known values
 *   run; no contextual or entropy rule. For prompts and tool results on their
 *   way to a provider, where a false alarm teaches people to switch the
 *   feature off.
 *
 * A finding holds a position and a salted fingerprint, never the value. The
 * scanner does not log, throw or return the text it matched.
 */
import { GLOBAL_ALLOWLIST, isAllowed, shannonEntropy } from "./heuristics";
import { PROVIDER_RULES } from "./rules";
import { CONTEXTUAL_RULES } from "./rulesContextual";
import { sha256Hex } from "./sha256";
import type {
  ScanOptions,
  SecretConfidence,
  SecretFinding,
  SecretProfile,
  SecretRule,
} from "./types";

export const DEFAULT_RULES: readonly SecretRule[] = [
  ...PROVIDER_RULES,
  ...CONTEXTUAL_RULES,
];

export const DEFAULT_ALLOW_MARKER = "secretscan:allow";

const RANK: Record<SecretConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Whether a rule runs under a profile. */
export function ruleAppliesTo(
  rule: SecretRule,
  profile: SecretProfile,
): boolean {
  if (profile === "at-rest") return true;
  return rule.confidence === "high" && rule.class === "structural";
}

let processSalt: string | undefined;

/** A random salt, fixed for this process, so fingerprints agree within a run. */
export function defaultSalt(): string {
  if (processSalt === undefined) {
    const bytes = new Uint8Array(16);
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.getRandomValues) c.getRandomValues(bytes);
    else
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = (Math.random() * 256) | 0;
    processSalt = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  return processSalt;
}

/** The salted short hash a finding carries: 8 hex digits. */
export function fingerprintOf(value: string, salt: string): string {
  return sha256Hex(`${salt}\u0000${value}`).slice(0, 8);
}

const compiled = new WeakMap<RegExp, RegExp>();

/** The rule's regex with the `d` flag (group offsets) and a fresh `lastIndex`. */
function withIndices(re: RegExp): RegExp {
  let c = compiled.get(re);
  if (!c) {
    c = new RegExp(
      re.source,
      re.flags.includes("d") ? re.flags : `${re.flags}d`,
    );
    compiled.set(re, c);
  }
  c.lastIndex = 0;
  return c;
}

/** Offsets of the lines that carry the allow marker, as [start, end) pairs. */
function markedLines(text: string, marker: string): [number, number][] {
  const out: [number, number][] = [];
  if (!marker) return out;
  let at = text.indexOf(marker);
  while (at !== -1) {
    const start = text.lastIndexOf("\n", at) + 1;
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl;
    out.push([start, end]);
    at = text.indexOf(marker, end);
  }
  return out;
}

interface Context {
  text: string;
  lower: string;
  salt: string;
  options: ScanOptions;
  marked: [number, number][];
}

function isMarked(ctx: Context, start: number): boolean {
  return ctx.marked.some(([s, e]) => start >= s && start <= e);
}

/** The value a match stands for, or undefined when the rule's gates reject it. */
function acceptedValue(
  rule: SecretRule,
  value: string | undefined,
  context: string,
): string | undefined {
  if (!value) return undefined;
  if (isAllowed(value, GLOBAL_ALLOWLIST, rule.allowlist)) return undefined;
  if (rule.entropy !== undefined && shannonEntropy(value) < rule.entropy) {
    return undefined;
  }
  if (rule.validate && !rule.validate(value, context)) return undefined;
  return value;
}

function runRule(
  rule: SecretRule,
  ctx: Context,
  profile: SecretProfile,
): SecretFinding[] {
  if (rule.keywords && !rule.keywords.some((k) => ctx.lower.includes(k))) {
    return [];
  }
  const path = ctx.options.path?.split(String.fromCharCode(92)).join("/");
  if (path && rule.skipPaths?.some((re) => re.test(path))) return [];
  const action =
    profile === "outbound" ? (rule.outboundAction ?? "redact") : "redact";
  const out: SecretFinding[] = [];
  const re = withIndices(rule.regex);
  const group = rule.group ?? 0;
  for (let m = re.exec(ctx.text); m; m = re.exec(ctx.text)) {
    if (m[0].length === 0) re.lastIndex++;
    const span = (m as RegExpExecArray & { indices?: [number, number][] })
      .indices?.[group];
    if (!span) continue;
    const value = acceptedValue(
      rule,
      m[group],
      ctx.text.slice(m.index, span[0]),
    );
    if (value === undefined) continue;
    const fingerprint = fingerprintOf(value, ctx.salt);
    if (ctx.options.allowFingerprints?.has(fingerprint)) continue;
    if (isMarked(ctx, span[0])) continue;
    out.push({
      ruleId: rule.id,
      kind: rule.kind,
      class: rule.class,
      start: span[0],
      end: span[1],
      confidence: rule.confidence,
      action,
      fingerprint,
    });
  }
  return out;
}

const CLASS_RANK = { known: 3, structural: 2, contextual: 1, entropy: 0 };

function better(a: SecretFinding, b: SecretFinding): boolean {
  if (CLASS_RANK[a.class] !== CLASS_RANK[b.class]) {
    return CLASS_RANK[a.class] > CLASS_RANK[b.class];
  }
  if (RANK[a.confidence] !== RANK[b.confidence]) {
    return RANK[a.confidence] > RANK[b.confidence];
  }
  return a.end - a.start > b.end - b.start;
}

/** Sort by position and, where two findings overlap, keep the better one. */
function resolveOverlaps(all: SecretFinding[]): SecretFinding[] {
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: SecretFinding[] = [];
  for (const f of all) {
    const last = kept[kept.length - 1];
    if (!last || f.start >= last.end) kept.push(f);
    else if (better(f, last)) kept[kept.length - 1] = f;
  }
  return kept;
}

/**
 * Find secrets in `text`. Findings are sorted by position and do not overlap.
 * With `options.known`, exact values of this machine's own secrets are found
 * under either profile.
 */
export function scanText(
  text: string,
  profile: SecretProfile,
  options: ScanOptions = {},
): SecretFinding[] {
  const ctx: Context = {
    text,
    lower: text.toLowerCase(),
    salt: options.salt ?? defaultSalt(),
    options,
    marked: markedLines(text, options.allowMarker ?? DEFAULT_ALLOW_MARKER),
  };
  const all: SecretFinding[] = [];
  for (const rule of options.rules ?? DEFAULT_RULES) {
    if (ruleAppliesTo(rule, profile)) all.push(...runRule(rule, ctx, profile));
  }
  for (const k of options.known?.find(text, ctx.salt) ?? []) {
    if (options.allowFingerprints?.has(k.fingerprint)) continue;
    all.push({
      ruleId: "known-value",
      kind: "known-value",
      class: "known",
      start: k.start,
      end: k.end,
      confidence: "high",
      action: "redact",
      fingerprint: k.fingerprint,
    });
  }
  return resolveOverlaps(all);
}

/** The placeholder for a finding: `[REDACTED:aws-access-key:1a2b]`. */
export function placeholderFor(finding: SecretFinding): string {
  return `[REDACTED:${finding.kind}:${finding.fingerprint.slice(0, 4)}]`;
}

/**
 * Replace each finding's span with its placeholder. The same value under the
 * same salt always gets the same placeholder, so a model can refer to it.
 * Findings must come from `scanText` on this same `text`. Findings whose
 * action is `warn` are left in the text: the caller reports them instead.
 */
export function redact(
  text: string,
  findings: readonly SecretFinding[],
): string {
  let out = "";
  let at = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < at || f.action === "warn") continue;
    out += text.slice(at, f.start) + placeholderFor(f);
    at = f.end;
  }
  return out + text.slice(at);
}

/** Findings per rule id, for a summary. */
export function countByRule(
  findings: readonly SecretFinding[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1;
  return counts;
}
