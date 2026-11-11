import { isSecretName } from "../../util/secretScan/secretNames";
import { maskText, PS_ENV_ASSIGN, PS_SET_ENV, SETX } from "./audit/mask";
import { looksSecret } from "./secretCommands";

/**
 * The command as a person reads it in a prompt or a refusal: the value of an
 * environment variable assignment is replaced when the variable is named like a
 * secret (`API_KEY`, `GITHUB_TOKEN`, `AWS_*`) or the value itself has the shape
 * of a credential. The NAME stays, so the person sees what is being set and
 * never the secret. The same masker as the audit trail decides the shapes
 * (`maskText`), so a key never shows in one place and hides in another.
 *
 * Display only: the command that runs, and the text every rule reads, is the
 * original. A command with nothing to hide comes back unchanged.
 */
const MASK = "«masked:secret-variable»";

/** `NAME=value` and `NAME+=value` in a POSIX command or a cmd `set`: value quoted or bare. */
const POSIX_ASSIGN =
  /(^|[\s;&|({]|\bset\s+"?|\bexport\s+)([A-Za-z_][A-Za-z0-9_]*)(\+?=)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)"']+)/gi;

function shouldMask(name: string, value: string): boolean {
  if (value.includes("«masked:")) return false;
  const bare = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  return (
    isSecretName(name) || looksSecret(name) || maskText(bare).kinds.length > 0
  );
}

function wrap(value: string): string {
  const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${q}${MASK}${q}`;
}

/** The command with the values of secret-looking assignments masked. */
export function maskAssignmentValues(command: string): string {
  let out = command;
  out = out.replace(
    POSIX_ASSIGN,
    (m, lead: string, name: string, op: string, value: string) =>
      shouldMask(name, value) ? `${lead}${name}${op}${wrap(value)}` : m,
  );
  out = out.replace(
    PS_ENV_ASSIGN,
    (
      m,
      head: string,
      a: string | undefined,
      b: string | undefined,
      value: string,
    ) => (shouldMask(a ?? b ?? "", value) ? `${head}${wrap(value)}` : m),
  );
  out = out.replace(
    PS_SET_ENV,
    (m, head: string, name: string, value: string) =>
      shouldMask(name, value) ? `${head}${wrap(value)}` : m,
  );
  return out.replace(SETX, (m, head: string, name: string, value: string) =>
    shouldMask(name, value) ? `${head}${wrap(value)}` : m,
  );
}
