/**
 * Shape tests on a candidate secret value: what a person would glance at to say
 * "that is a function call, a path, a version, not a password". Pure and
 * dependency free (imported by code the GUI bundles).
 *
 * Each test answers one false-positive category measured in X11 (plans/ROADMAP.md
 * X11a) over real transcripts: code expressions, dotted identifiers, grep output
 * (`file.ts:99:`), paths, URLs, versions, UUIDs, references to other variables,
 * query-string fragments and short low-entropy words. The tests look at the
 * value only; none of them keeps it.
 */
import { shannonEntropy } from "./heuristics";

/** Characters that mean code, a regex or markup, not a generated secret. */
const CODE_PUNCTUATION = /[()[\]{}<>\\\x60|;]/;
/** A reference to another variable: `$VAR`, `${VAR}`, `$(cmd)`, `%VAR%`. */
const VARIABLE_REFERENCE = /\$[{(A-Za-z_]|%[A-Za-z_]\w*%/;
/** Another `name=` after an `&`: a query string, not one value. */
const QUERY_FRAGMENT = /&[A-Za-z_][\w.-]*=/;
/** `file.ts:99:` or `:12:` at the end: grep and stack-trace output. */
const LOCATION_SUFFIX = /(?:\.[A-Za-z0-9]{1,5}:\d+|:\d+:)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const DOTTED_IDENTIFIER =
  /^[A-Za-z_$][A-Za-z_$]*\d{0,3}(?:\??\.[A-Za-z_$][A-Za-z_$]*\d{0,3})+$/;
const WORD_ONLY = /^[A-Za-z]+(?:[_-][A-Za-z]+)*\d{0,3}$/;
const CAMEL = /^[a-z]+(?:[A-Z][a-z]+)+\d{0,3}$/;
/** Names whose values are secrets often enough to keep short values. */
const STRONG_NAME = /passw(?:or)?d|passwd|pwd|secret|token/i;
/** Names of values that are digests or ids, never credentials. */
const DIGEST_NAME =
  /cache|checksum|digest|integrity|sha\d*|md5|hash|commit|revision|etag|fingerprint|thumbprint|_?id$/i;

/** Number of character classes (lower, upper, digit, other) present. */
export function characterClasses(value: string): number {
  let n = 0;
  if (/[a-z]/.test(value)) n++;
  if (/[A-Z]/.test(value)) n++;
  if (/\d/.test(value)) n++;
  if (/[^A-Za-z0-9]/.test(value)) n++;
  return n;
}

/** A file path: has an extension, or is slash-separated lowercase words. */
export function looksLikePath(value: string): boolean {
  if (!value.includes("/")) return false;
  if (/^[A-Za-z]:[\\/]|^(?:\.{1,2}|~)\//.test(value)) return true;
  const segments = value.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(value)) return true;
  // Words of one case per segment (`ibm/granite-13b:v2`, `ENV_NAME/PART`):
  // a random base64 segment mixes cases.
  return segments.every((s) => /^(?:[a-z0-9._@~:-]+|[A-Z0-9._@~:-]+)$/.test(s));
}

/** A hex string of a digest length (32, 40, 64 or 128). */
export function isHexDigest(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value) && [32, 40, 64, 128].includes(value.length);
}

/** Code, grep output, a variable reference or a query string, not a credential. */
export function looksLikeCodeOrReference(value: string): boolean {
  return (
    CODE_PUNCTUATION.test(value) ||
    VARIABLE_REFERENCE.test(value) ||
    QUERY_FRAGMENT.test(value) ||
    LOCATION_SUFFIX.test(value)
  );
}

/** A name, not a secret: dotted identifier, camelCase, snake_case words, version, UUID. */
export function looksLikeIdentifierOrId(value: string): boolean {
  return (
    DOTTED_IDENTIFIER.test(value) ||
    CAMEL.test(value) ||
    WORD_ONLY.test(value) ||
    VERSION.test(value) ||
    UUID.test(value) ||
    /^[A-Za-z0-9]+(?:[-._][A-Za-z0-9]+){2,}$/.test(value) // slug of 3+ parts
  );
}

/** Minimum length for a value next to a name that is not password/secret/token. */
const WEAK_NAME_MIN_LENGTH = 16;
const WEAK_NAME_MIN_ENTROPY = 3.5;
const STRONG_NAME_MIN_CLASSES = 3;

/**
 * Whether `value`, found after `name`, has the shape of a generated secret.
 * `name` is the text before the value (the variable name and delimiter).
 */
export function plausibleAssignedSecret(value: string, name = ""): boolean {
  if (looksLikeCodeOrReference(value)) return false;
  if (looksLikePath(value) || value.includes("://")) return false;
  if (looksLikeIdentifierOrId(value)) return false;
  if (isHexDigest(value) && DIGEST_NAME.test(name)) return false;
  if (STRONG_NAME.test(name)) {
    return (
      value.length >= WEAK_NAME_MIN_LENGTH ||
      characterClasses(value) >= STRONG_NAME_MIN_CLASSES
    );
  }
  return (
    value.length >= WEAK_NAME_MIN_LENGTH &&
    shannonEntropy(value) >= WEAK_NAME_MIN_ENTROPY
  );
}

const PLACEHOLDER_PASSWORD =
  /^(?:pass(?:word|wd)?|secret|root|admin|user(?:name)?|test(?:ing)?|changeme|change[_-]?me|example|demo|dummy|sample|redacted|token|key|none|null|(?:your|my)[\w-]*|\*+|x+|\.+|\d+)$/i;
/**
 * The password of `scheme://user:password@host` is a real credential: long
 * enough, not a placeholder word, not a reference to a variable, not the
 * template of a format string, with some variety of characters.
 */
export function plausibleUrlPassword(password: string): boolean {
  if (password.length < 8) return false;
  if (looksLikeCodeOrReference(password) || /%s|%d|\*{2,}|\.{3}/.test(password))
    return false;
  if (PLACEHOLDER_PASSWORD.test(password)) return false;
  if (/^(?:pass|secret|password|changeme)/i.test(password)) return false;
  if (new Set(password).size < 4) return false;
  return characterClasses(password) >= 2 && shannonEntropy(password) >= 2.5;
}
