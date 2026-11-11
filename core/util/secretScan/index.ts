/**
 * The shared secret rule set (plans/ROADMAP.md X9). Everything exported here
 * is pure and safe for code the GUI bundles. `machineSecrets.ts` (file reads)
 * and `scanFiles.ts` (the file scanner behind `continuous secrets scan`) are
 * Node only and are imported by path.
 */
export { CONTEXTUAL_RULES } from "./rulesContextual";
export { PROVIDER_RULES } from "./rules";
export { secretValuesFromEnv, plausibleSecretValue } from "./envValues";
export { SECRET_NAME_PATTERNS, isSecretName } from "./secretNames";
export { shannonEntropy } from "./heuristics";
export { knownValueMatcher, MIN_KNOWN_LENGTH } from "./knownValues";
export {
  DEFAULT_ALLOW_MARKER,
  DEFAULT_RULES,
  countByRule,
  defaultSalt,
  fingerprintOf,
  placeholderFor,
  redact,
  ruleAppliesTo,
  scanText,
} from "./scan";
export type {
  KnownMatch,
  KnownValueMatcher,
  RuleAllowlist,
  ScanOptions,
  SecretAction,
  SecretConfidence,
  SecretFinding,
  SecretProfile,
  SecretRule,
  SecretRuleClass,
} from "./types";
export { scrubDeep, scrubForDisk } from "./scrubForDisk";
