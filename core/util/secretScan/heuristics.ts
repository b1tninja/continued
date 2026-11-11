import type { RuleAllowlist } from "./types";

/** Shannon entropy of `value` in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const total = Array.from(value).length;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Example and placeholder values no rule reports, whatever the rule: the
 * documentation keys (`AKIAIOSFODNN7EXAMPLE`), runs of one character, `xxxx`,
 * `${VAR}`, `{{ var }}`, `<token>`, `%VAR%`, "your api key" and the words
 * people put where a secret goes. Tested against the secret value only.
 */
export const GLOBAL_ALLOWLIST: RuleAllowlist = {
  patterns: [
    /^(.)\1{5,}$/s,
    /([xX*#.])\1{3,}/,
    /^\$\{?[A-Za-z_][^\s]*$/,
    /^\{\{.*\}\}$/s,
    /^<[^<>]*>$/,
    /^%[A-Za-z_]\w*%$/,
    /^\[REDACTED/,
    /^«masked:/,
    /(?:your|my)[_ -]?(?:api[_ -]?)?(?:key|token|secret|password)/i,
    /^(?:placeholder|changeme|change[_-]me|dummy|redacted|sample|todo|none|null|undefined|secret|password|token)$/i,
  ],
  substrings: ["example", "placeholder", "changeme", "redacted", "<your"],
};

export function isAllowed(
  value: string,
  ...lists: (RuleAllowlist | undefined)[]
): boolean {
  const lower = value.toLowerCase();
  for (const list of lists) {
    if (!list) continue;
    if (list.patterns?.some((re) => re.test(value))) return true;
    if (list.substrings?.some((s) => lower.includes(s.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

/** At least one letter and one digit, the shape of a generated secret. */
export function hasLetterAndDigit(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/** Decode base64url, or "" when it is not valid. */
export function decodeBase64Url(segment: string): string {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return atob(padded);
  } catch {
    return "";
  }
}
