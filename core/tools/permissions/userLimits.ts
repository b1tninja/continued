import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";

/**
 * The person's own numeric limits for the built-in ask rules (ROADMAP B57),
 * read straight from their config.yaml and from no other file: a workspace
 * file that could raise the limit could switch the rule off. A value that is
 * not a whole number of at least 1 is ignored, which leaves the default.
 *
 * `toolPermissions.auto.environment.largeChangeLines` is the number of changed
 * lines above which `ask-large-change` asks (default 300).
 */
export function parseLargeChangeLines(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

export function readUserLargeChangeLines(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): number | undefined {
  try {
    const root = YAML.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return parseLargeChangeLines(
      root?.toolPermissions?.auto?.environment?.largeChangeLines,
    );
  } catch {
    return undefined;
  }
}
