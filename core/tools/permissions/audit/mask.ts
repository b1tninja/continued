import { createHash } from "node:crypto";
import { looksSecret } from "../secretCommands";

/**
 * Masking for the audit trail (plans/reviewer-audit.md, section 6). Text is
 * masked before anything is written or hashed, so the file never holds a value
 * this module recognised as a credential. It is best effort: a secret in a
 * shape nobody listed passes through, and the audit file is local and private
 * for that reason.
 *
 * A masked value becomes `«masked:<kind>»`, so a reader still sees what kind
 * of thing was there. Masking is idempotent: running it again on its own
 * output changes nothing.
 */
export interface MaskResult {
  text: string;
  /** The kinds that were masked, in order of first appearance */
  kinds: string[];
}

const mark = (kind: string) => `«masked:${kind}»`;
const MASK_PREFIX = "«masked:";

/** Credential shapes that are recognisable on their own */
const SHAPES: [kind: string, re: RegExp][] = [
  [
    "private-key",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["api-key", /\bsk[-_](?:live|proj|test)?[-_]?[A-Za-z0-9_-]{20,}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  ],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g],
];

/** `Authorization: Bearer x`, `Cookie: a=b`, `X-Api-Key: x` */
const HEADER =
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*:\s*)((?:bearer|basic|token|digest)\s+)?([^\s"'\\]+(?:[ \t]*;[ \t]*[^\s"'\\;]+)*)/gi;

/** `scheme://user:password@host` */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)([^\s/@"']+)(@)/gi;

/** `"api_key": "value"` in a JSON argument */
const JSON_PAIR = /("([^"\\]{1,60})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/** `NAME=value`, with the value quoted or bare */
const ASSIGN =
  /(\b[A-Za-z_][A-Za-z0-9_.-]*=)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|"'`)]+)/g;

/** `--password hunter2`, `--api-key=x`, `-H` is handled by HEADER */
const FLAG =
  /(--[A-Za-z][A-Za-z0-9-]*)([= ]+)("[^"]*"|'[^']*'|[^\s"';&|-][^\s"';&|]*)/g;

/** `?token=abc&x=1` */
const QUERY = /([?&])([A-Za-z0-9_.-]{1,40})=([^&\s"'#]+)/g;

function alreadyMasked(value: string): boolean {
  return value.replace(/^["']/, "").startsWith(MASK_PREFIX);
}

function unquoted(value: string): { q: string; v: string } {
  const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return {
    q,
    v: q ? value.slice(1, value.endsWith(q) ? -1 : undefined) : value,
  };
}

/** Mask the credentials in `text`. */
export function maskText(text: string): MaskResult {
  const kinds: string[] = [];
  const seen = (k: string) => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  let out = text;

  for (const [kind, re] of SHAPES) {
    out = out.replace(re, () => {
      seen(kind);
      return mark(kind);
    });
  }

  out = out.replace(
    HEADER,
    (
      m,
      name: string,
      sep: string,
      scheme: string | undefined,
      value: string,
    ) => {
      if (alreadyMasked(value)) return m;
      seen("header");
      return `${name}${sep}${scheme ?? ""}${mark("header")}`;
    },
  );

  out = out.replace(URL_USERINFO, (m, head: string, pw: string, at: string) => {
    if (alreadyMasked(pw)) return m;
    seen("url-password");
    return `${head}${mark("url-password")}${at}`;
  });

  out = out.replace(
    JSON_PAIR,
    (m, head: string, key: string, value: string) => {
      if (!looksSecret(key) || alreadyMasked(value)) return m;
      seen("secret-field");
      return `${head}"${mark("secret-field")}"`;
    },
  );

  out = out.replace(ASSIGN, (m, head: string, value: string) => {
    const name = head.slice(0, -1);
    if (!looksSecret(name) || alreadyMasked(value)) return m;
    seen("secret-variable");
    const { q } = unquoted(value);
    return `${head}${q}${mark("secret-variable")}${q}`;
  });

  out = out.replace(FLAG, (m, flag: string, sep: string, value: string) => {
    if (!looksSecret(flag.slice(2)) || alreadyMasked(value)) return m;
    seen("secret-flag");
    const { q } = unquoted(value);
    return `${flag}${sep}${q}${mark("secret-flag")}${q}`;
  });

  out = out.replace(QUERY, (m, lead: string, name: string, value: string) => {
    if (!looksSecret(name) || alreadyMasked(value)) return m;
    seen("secret-query");
    return `${lead}${name}=${mark("secret-query")}`;
  });

  return { text: out, kinds };
}

/**
 * Clip text that is already masked. A cut never lands inside a masked span:
 * if it would, it moves back to the start of that span.
 */
export function clipMasked(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const open = text.lastIndexOf("«", cut - 1);
  const close = text.lastIndexOf("»", cut - 1);
  if (open > close) cut = open;
  return `${text.slice(0, cut)} [cut]`;
}

/** SHA-256 of masked text. Never hash the raw text: a hash of a low-entropy secret can be guessed. */
export function hashMasked(masked: string): string {
  return createHash("sha256").update(masked, "utf8").digest("hex");
}

/** Mask, then clip, then hash the masked full text: what a call's arguments become in a record. */
export function maskForAudit(
  text: string,
  max: number,
): { masked: string; hash: string; length: number; kinds: string[] } {
  const { text: full, kinds } = maskText(text);
  return {
    masked: clipMasked(full, max),
    hash: hashMasked(full),
    length: text.length,
    kinds,
  };
}

/** Mask every string in a JSON-like value (a second pass the writer applies). */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskText(value).text as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => maskDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      o[k] = maskDeep(v);
    }
    return o as T;
  }
  return value;
}
