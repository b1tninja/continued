/**
 * The secret values in an environment, picked by the names
 * `scrubEnvironment` treats as secret (`SECRET_NAME_PATTERNS`, one list). Pure: it
 * reads the `env` it is given. The returned array holds values, so it is for
 * `knownValueMatcher` and nothing else: do not log it, store it or send it.
 */
import { urlHasCredentials } from "../scrubEnvironment";

import { isSecretName } from "./secretNames";

/** Names that match a secret pattern but whose value is a setting, not a secret. */
const SETTING_NAME =
  /(?:_REGION|_DEFAULT_REGION|_PROFILE|_ENDPOINT|_DIR|_PATH|_HOST|_PORT|_MODE|_ENABLED|_DEBUG|_LEVEL|_VERBOSE|_SOCK|_FILE|_HOME)$|^(?:CONTINUE|CONTINUOUS)_(?:GLOBAL|AUDIT|TERMINAL)/i;

/** Whether `value` could be a secret at all: not a path, a flag, a number or a bare URL. */
export function plausibleSecretValue(value: string): boolean {
  if (value.length < 8) return false;
  if (/^(?:true|false|yes|no|on|off|null|none|undefined)$/i.test(value)) {
    return false;
  }
  if (/^\d+(?:\.\d+)*$/.test(value)) return false;
  if (/^(?:[A-Za-z]:[\\/]|\/|~|\.\.?[\\/])/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return urlHasCredentials(value);
  return true;
}

/** The values of the environment variables that look like secrets by name. */
export function secretValuesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    // A name on the list, or a URL carrying credentials under any name: the
    // two reasons `scrubEnvironment` removes a variable.
    const secretByName = isSecretName(name);
    if (!value || SETTING_NAME.test(name) || !plausibleSecretValue(value)) {
      continue;
    }
    if (secretByName || urlHasCredentials(value)) out.push(value);
  }
  return out;
}
