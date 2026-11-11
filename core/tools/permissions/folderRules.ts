import type { ToolPermissions } from "./rules";

/**
 * The `toolPermissions` of configuration files that came with the workspace,
 * as they were written, before the loader removed what a repository may not
 * set (trust.ts). The loader records them here so the Permissions page can
 * show an `allow` rule that is being ignored instead of letting it vanish.
 * Nothing reads this to decide a call: the rules that run are the ones the
 * loader kept.
 */
const recorded = new Map<string, ToolPermissions>();

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === "string");
  return list.length ? list : undefined;
}

/** Forget what the last load recorded; the loader calls this before it records. */
export function clearFolderRules(): void {
  recorded.clear();
}

/** Remember the rules in one workspace file (a parsed YAML block). */
export function recordFolderRules(file: string, parsed: unknown): void {
  const perms = (parsed as { toolPermissions?: Record<string, unknown> } | null)
    ?.toolPermissions;
  if (!perms || typeof perms !== "object") return;
  const allow = strings(perms.allow);
  const ask = strings(perms.ask);
  const deny = strings(perms.deny);
  if (!allow && !ask && !deny) return;
  recorded.set(file, {
    ...(allow ? { allow } : {}),
    ...(ask ? { ask } : {}),
    ...(deny ? { deny } : {}),
  });
}

/** The rules recorded by the last load, by file. */
export function recordedFolderRules(): {
  file: string;
  permissions: ToolPermissions;
}[] {
  return [...recorded].map(([file, permissions]) => ({ file, permissions }));
}
