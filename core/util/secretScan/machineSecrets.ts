/**
 * Collect this machine's own secret values: the environment and the
 * well-known credential files. Node only (it reads files), so it is not
 * exported from `index.ts` and must not be imported by code the GUI bundles.
 *
 * The result holds values. Feed it to `knownValueMatcher` and drop it; never
 * log, store or send it. `sources` names where values came from (a file name
 * or "environment"), never a value.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { secretValuesFromEnv, plausibleSecretValue } from "./envValues";
import { knownValueMatcher } from "./knownValues";
import type { KnownValueMatcher } from "./types";

const MAX_FILE_BYTES = 256 * 1024;

export interface MachineSecrets {
  values: string[];
  /** Where values were found: "environment" or a path relative to home. */
  sources: string[];
}

export interface MachineSecretOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

function readSmall(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `key = value` or `key=value` lines whose key matches `names`. */
function iniValues(text: string, names: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.+?)\s*$/.exec(line);
    if (m && names.test(m[1])) out.push(m[2].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** Base64 lines of a PEM private key: every line, so a partial paste still matches. */
function pemLines(text: string): string[] {
  if (!/-----BEGIN[^-]*PRIVATE KEY-----/.test(text)) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 32 && /^[A-Za-z0-9+/=]+$/.test(l));
}

function sshValues(home: string): string[] {
  const dir = path.join(home, ".ssh");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const skip = /\.pub$|^known_hosts|^authorized_keys|^config$|^environment$/;
  return names
    .filter((n) => !skip.test(n))
    .flatMap((n) => pemLines(readSmall(path.join(dir, n)) ?? ""));
}

function userinfoPasswords(text: string): string[] {
  return [
    ...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi),
  ].map((m) => m[1]);
}

function jsonAuthValues(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /"(?:auth|identitytoken|registrytoken|oauth_token|token)"\s*:\s*"([^"]{8,})"/gi,
  )) {
    out.push(m[1]);
  }
  return out;
}

type Extractor = (text: string) => string[];

const SECRET_KEY_NAMES =
  /secret|token|passw|pwd|credential|api[_-]?key|access[_-]?key|auth/i;

const FILES: [rel: string, extract: Extractor][] = [
  [
    ".aws/credentials",
    (t) => iniValues(t, /^aws_(?:secret_access_key|session_token)$/i),
  ],
  [
    ".npmrc",
    (t) =>
      [...t.matchAll(/(?:_authToken|_password|_auth)\s*=\s*"?([^\s"]+)/g)].map(
        (m) => m[1],
      ),
  ],
  [".netrc", (t) => [...t.matchAll(/\bpassword\s+(\S+)/g)].map((m) => m[1])],
  [".git-credentials", userinfoPasswords],
  [".docker/config.json", jsonAuthValues],
  [".config/gh/hosts.yml", (t) => iniValues(t, /oauth_token/i)],
  [".continue/.env", (t) => iniValues(t, SECRET_KEY_NAMES)],
];

/** Read the environment and the well-known credential files under `home`. */
export function collectMachineSecrets(
  options: MachineSecretOptions = {},
): MachineSecrets {
  const home = options.home ?? os.homedir();
  const values: string[] = [];
  const sources: string[] = [];
  const add = (source: string, found: string[]) => {
    const plausible = found.filter(plausibleSecretValue);
    if (plausible.length) {
      values.push(...plausible);
      sources.push(source);
    }
  };
  add("environment", secretValuesFromEnv(options.env ?? process.env));
  for (const [rel, extract] of FILES) {
    const text = readSmall(path.join(home, ...rel.split("/")));
    if (text !== undefined) add(rel, extract(text));
  }
  add(".ssh", sshValues(home));
  return { values, sources: [...new Set(sources)] };
}

/** A matcher over this machine's secrets, and where they came from. */
export function machineMatcher(options: MachineSecretOptions = {}): {
  matcher: KnownValueMatcher;
  sources: string[];
} {
  const { values, sources } = collectMachineSecrets(options);
  return { matcher: knownValueMatcher(values), sources };
}
