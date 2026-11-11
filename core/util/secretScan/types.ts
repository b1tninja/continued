/**
 * Types for the shared secret rule set (plans/ROADMAP.md rows X9, X10, X7).
 *
 * Pure and dependency free: this module is imported by code that also runs in
 * the GUI webview, so nothing here touches `process`, `fs` or `node:*`.
 *
 * No type in this directory has a field that holds a secret value. A finding
 * is a position and a salted fingerprint, never the text it points at.
 */

/** `at-rest`: recall first (captures, fixtures, datasets, audit, logs).
 * `outbound`: precision first (prompts and tool results sent to a provider). */
export type SecretProfile = "at-rest" | "outbound";

/**
 * What a caller does with a finding: `redact` replaces the value with its
 * placeholder, `warn` tells the person and sends the text as it is.
 */
export type SecretAction = "redact" | "warn";

export type SecretConfidence = "high" | "medium" | "low";

/**
 * `known`: an exact value of this machine's own secrets.
 * `structural`: a fixed prefix or shape (provider key formats, PEM blocks).
 * `contextual`: depends on a nearby name (`NAME=value`, URL userinfo, headers).
 * `entropy`: a high-entropy string next to a secret-like name.
 */
export type SecretRuleClass = "known" | "structural" | "contextual" | "entropy";

/** Values a rule never reports. Matched against the secret value only. */
export interface RuleAllowlist {
  /** The value matches one of these patterns. */
  patterns?: readonly RegExp[];
  /** The value contains one of these, compared case-insensitively. */
  substrings?: readonly string[];
}

export interface SecretRule {
  /** Stable rule id, kebab case, unique. */
  id: string;
  /** What the placeholder says: `[REDACTED:<kind>:xxxx]`. Several rules may share one. */
  kind: string;
  description: string;
  class: Exclude<SecretRuleClass, "known">;
  confidence: SecretConfidence;
  /** Must have the `g` flag. */
  regex: RegExp;
  /** Capture group that holds the secret; 0 (the default) is the whole match. */
  group?: number;
  /** Minimum Shannon entropy (bits per character) of the secret value. */
  entropy?: number;
  /** Lowercase strings; the rule runs only when the text contains one of them. */
  keywords?: readonly string[];
  allowlist?: RuleAllowlist;
  /**
   * A structural check after the regex and the entropy gate. `context` is the
   * text of the match before the value (the name and delimiter), for rules
   * that decide by name and shape together.
   */
  validate?: (value: string, context: string) => boolean;
  /**
   * Findings of this rule under the outbound profile carry this action. The
   * default is `redact`; `warn` reports the value and leaves it in the text.
   */
  outboundAction?: SecretAction;
  /** Files (by path) where the rule does not run: tests, fixtures, examples. */
  skipPaths?: readonly RegExp[];
  /** Where the rule came from (a gitleaks rule id, or `own`). */
  origin: string;
}

/** A place in the text where a secret is. It never holds the secret. */
export interface SecretFinding {
  ruleId: string;
  kind: string;
  class: SecretRuleClass;
  /** Offset of the first character of the secret value. */
  start: number;
  /** Offset after the last character of the secret value. */
  end: number;
  confidence: SecretConfidence;
  /** `redact` for most findings; `warn` for a rule that is warn-only in this profile. */
  action: SecretAction;
  /** First 8 hex digits of SHA-256(salt + value). Same value, same salt, same fingerprint. */
  fingerprint: string;
}

export interface ScanOptions {
  /** Salt for fingerprints. Default: a random salt, fixed for this process. */
  salt?: string;
  /** Extra values (by fingerprint under the same salt) that are not secrets. */
  allowFingerprints?: ReadonlySet<string>;
  /** Matcher over this machine's own secrets (see `knownValueMatcher`). */
  known?: KnownValueMatcher;
  /** Rules to use instead of `DEFAULT_RULES`. */
  rules?: readonly SecretRule[];
  /** Path of the file being scanned, for rules that skip test and fixture paths. */
  path?: string;
  /** Skip lines that contain this marker. Default `secretscan:allow`; "" disables it. */
  allowMarker?: string;
}

/** The result of a lookup over the machine's own secret values. */
export interface KnownValueMatcher {
  /** Number of distinct values held. The values themselves are not retrievable. */
  readonly size: number;
  /** Positions of known values in `text`. */
  find(text: string, salt: string): KnownMatch[];
}

export interface KnownMatch {
  start: number;
  end: number;
  fingerprint: string;
}
