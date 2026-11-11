import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";

/**
 * The domains the person trusts: `toolPermissions.auto.environment.trustedDomains`
 * in their own config.yaml, read directly like `readUserGuidance` does. The list
 * loosens what runs without asking, so a workspace file, an assistant or a hub
 * block cannot be its source (trust.ts strips it from those). It is not read
 * through `sanitizeToolPermissions`, which keeps only the rule lists.
 *
 * Parsed results are cached per file by modification time and size, so a tool
 * call does not re-read and re-parse the file; an edit shows on the next call.
 */
interface Cached {
  mtimeMs: number;
  size: number;
  domains: string[];
}

const cache = new Map<string, Cached>();

export function sanitizeTrustedDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function parseDomains(file: string): string[] {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const root = YAML.parse(text) as any;
  return sanitizeTrustedDomains(
    root?.toolPermissions?.auto?.environment?.trustedDomains,
  );
}

export function readUserTrustedDomains(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): string[] {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.domains;
    }
    const domains = parseDomains(file);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, domains });
    return domains;
  } catch {
    // Missing or unreadable is no list, never a throw
    cache.delete(file);
    return [];
  }
}

/** For tests: forget what was read. */
export function clearUserTrustedDomainsCache(): void {
  cache.clear();
}
