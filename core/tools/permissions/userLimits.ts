import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";

/**
 * The person's own numeric limits for the built-in ask rules (ROADMAP B57),
 * read straight from their config.yaml and from no other file: a workspace
 * file that could raise the limit could switch the rule off. A value that is
 * not a whole number of at least 1 is ignored, which leaves the default.
 * Parsed results are cached per file by modification time and size, like
 * userTrustedDomains.ts.
 *
 * `toolPermissions.auto.environment.largeChangeLines` is the number of changed
 * lines above which `ask-large-change` asks (default 300).
 */
interface Cached {
  mtimeMs: number;
  size: number;
  value: number | undefined;
}

const cache = new Map<string, Cached>();

export function parseLargeChangeLines(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

export function readUserLargeChangeLines(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): number | undefined {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    const value = parseLargeChangeLines(
      root?.toolPermissions?.auto?.environment?.largeChangeLines,
    );
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    cache.delete(file);
    return undefined;
  }
}
