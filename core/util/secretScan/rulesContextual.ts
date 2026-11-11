/**
 * Contextual and entropy rules: a value is a secret because of the name next
 * to it, not because of its own shape. They are the source of false positives,
 * so none is `high`: the outbound profile never runs them, and the at-rest
 * profile (local files, where over-reporting costs a review) does.
 *
 * Origin: all written for this project. The name lists follow the secret-name
 * patterns of `core/util/scrubEnvironment.ts`; the structure of the checks
 * (name, delimiter, value, entropy gate) is the one gitleaks' generic rule and
 * detect-secrets' keyword detector use, without taking their patterns.
 */
import { hasLetterAndDigit } from "./heuristics";
import type { SecretRule } from "./types";
import { looksLikePath, plausibleAssignedSecret } from "./valueShape";

/**
 * Files where a `NAME=value` is a fixture, an example or a sample: tests,
 * mocks, fixtures, examples, docs and the like. The provider-key rules still
 * run there; only the name-based guess is skipped.
 */
export const TEST_AND_EXAMPLE_PATHS: readonly RegExp[] = [
  /(?:^|\/)(?:tests?|__tests__|__mocks__|__fixtures__|fixtures?|testdata|mocks?|examples?|samples?|e2e)\//i,
  /\.(?:test|spec|vitest|e2e|stories)\.[cm]?[jt]sx?$/i,
  /(?:^|[._-])(?:test|tests|spec|fixture|fixtures|mock|example|sample)\.[a-z]+$/i,
  /\.(?:example|sample|template|dist)$/i,
];

const NOT_A_VALUE =
  /^(?:\$|\{\{|<|%|process\.|os\.|env\.|config\.|self\.|this\.|args\.|settings\.|secrets\.|getenv|\.{0,2}\/)/i;

/** Looks like generated secret text rather than an identifier or a word. */
function looksGenerated(value: string): boolean {
  if (NOT_A_VALUE.test(value)) return false;
  if (value.includes("://") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  // model names, versions, slugs: lowercase words joined by - . or _
  if (/^[a-z0-9]+(?:[-._][a-z0-9]+)+$/.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  return hasLetterAndDigit(value) || value.length >= 24;
}

const NAME_WORDS =
  "api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|credentials?|private[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret";

export const CONTEXTUAL_RULES: readonly SecretRule[] = [
  {
    id: "connection-string-password",
    kind: "connection-string",
    description: "Password in a URL (user:password@host)",
    class: "contextual",
    confidence: "medium",
    regex:
      /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"<>]+:([^\s@/'"<>]{3,})@[^\s'"<>/]+/gi,
    group: 1,
    keywords: ["://"],
    allowlist: {
      patterns: [/^(?:pass|secret|root|admin|postgres|test|user|pwd|db)$/i],
      substrings: ["password", "passwd"],
    },
    origin: "own (masker URL_USERINFO)",
  },
  {
    id: "bearer-token",
    kind: "bearer-token",
    description: "Authorization header value (Bearer ...)",
    class: "contextual",
    confidence: "medium",
    regex: /\bbearer\s+([A-Za-z0-9._~+/=-]{20,})/gi,
    group: 1,
    entropy: 3.5,
    keywords: ["bearer"],
    validate: (value) => !NOT_A_VALUE.test(value) && !looksLikePath(value),
    origin: "own (masker HEADER)",
  },
  {
    id: "env-secret-assignment",
    kind: "env-secret",
    description:
      "NAME=value where the name says secret, key, token or password",
    class: "contextual",
    confidence: "medium",
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:${NAME_WORDS})(?:[_-](?:key|value|id|secret|token|str|string)){0,2}["']?\s*[:=]\s*["'\x60]?([^\s"'\x60,;#&]{8,})`,
      "gi",
    ),
    group: 1,
    entropy: 3,
    keywords: ["key", "secret", "token", "passw", "pwd", "credential", "auth"],
    // looksGenerated drops the obvious non-values; plausibleAssignedSecret then
    // applies the X11a shape tests (code, paths, ids, length and entropy by name).
    validate: (value, context) =>
      looksGenerated(value) && plausibleAssignedSecret(value, context),
    skipPaths: TEST_AND_EXAMPLE_PATHS,
    origin: "own (masker ASSIGN, scrubEnvironment names)",
  },
  {
    id: "generic-secret",
    kind: "generic-secret",
    description:
      "A quoted high-entropy string assigned to a name that contains secret, token, key or password",
    class: "entropy",
    confidence: "low",
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:${NAME_WORDS})[A-Za-z0-9_.-]*["']?\s*[:=]\s*["'\x60]([A-Za-z0-9+/_.=-]{24,})["'\x60]`,
      "gi",
    ),
    group: 1,
    entropy: 4,
    keywords: ["key", "secret", "token", "passw", "pwd", "credential"],
    validate: (value) => looksGenerated(value) && !looksLikePath(value),
    skipPaths: TEST_AND_EXAMPLE_PATHS,
    origin: "own",
  },
];
