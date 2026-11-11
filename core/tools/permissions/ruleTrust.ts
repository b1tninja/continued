import type { ToolPermissions } from "./rules";

/**
 * Who may add `allow` rules. Only the person's own configuration may loosen
 * what runs without asking: their user-level config.yaml. An assistant from
 * the hub, a shared config or a project folder may still tighten (`deny`,
 * `ask`), which is always accepted. The same rule as `terminal.*`
 * (resolveTerminalSettings in core/util/terminalEnvironment.ts), and the same
 * outcome for a source that breaks it: ignored, with one notice per rule.
 *
 * Both dialects pass through here: core's `runTerminalCommand(...)` rules in
 * config.yaml, and the CLI's `Bash(...)` rules in permissions.yaml, which is
 * the person's own file and so is not routed through this function (it is
 * read as the user's source; see extensions/cli/src/permissions).
 */
export interface ToolPermissionsResolution {
  /** The rules to enforce: the merged ones, minus `allow` rules nobody owns. */
  permissions: ToolPermissions | undefined;
  /** One line per ignored rule, for non-fatal config errors or a log. */
  notices: string[];
}

const norm = (rule: string) => rule.trim();

/**
 * `merged` is every source's rules together (what the config loader built);
 * `user` is what the person's own config.yaml sets. An allow rule survives
 * only if the user's own file has it. Pure.
 */
export function resolveToolPermissions(
  user: ToolPermissions | undefined,
  merged: ToolPermissions | undefined,
): ToolPermissionsResolution {
  if (!merged?.allow?.length) return { permissions: merged, notices: [] };
  const own = new Set((user?.allow ?? []).map(norm));
  const kept: string[] = [];
  const notices: string[] = [];
  for (const rule of merged.allow) {
    if (typeof rule === "string" && own.has(norm(rule))) kept.push(rule);
    else {
      notices.push(
        `toolPermissions.allow: ${JSON.stringify(rule)} from the assistant or project configuration was ignored: allow rules are taken from your own config.yaml only (deny and ask rules from any source are kept).`,
      );
    }
  }
  const { allow: _dropped, ...rest } = merged;
  return {
    permissions: kept.length ? { ...rest, allow: kept } : rest,
    notices,
  };
}
