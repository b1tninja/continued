import { SYSTEM_TEMP_ROOTS, MACOS_PRIVATE_ALIASED } from "./sandboxPolicyData";
import type {
  EnforcedItem,
  SandboxCompileInput,
  SandboxConflict,
  SandboxEffect,
  SandboxSource,
} from "./sandboxPolicyTypes";

/** Accumulator and helpers shared by the compiler's steps. */

export type FsEffect = Extract<
  SandboxEffect,
  "denyRead" | "denyWrite" | "allowRead" | "allowWrite"
>;

export interface Ctx {
  input: SandboxCompileInput;
  ws: string;
  tmp: string;
  home: string;
  extra: string[];
  readable: string[];
  locked: string[];
  /** Directories the person may write: workspace first */
  roots: string[];
}

export interface Acc {
  platform: SandboxCompileInput["platform"];
  fs: Record<FsEffect, Set<string>>;
  allowed: Set<string>;
  denied: Set<string>;
  enforced: EnforcedItem[];
  policyOnly: string[];
  conflicts: SandboxConflict[];
  warnings: string[];
  weakened: string[];
  precreate: Set<string>;
  /** Absolute entries from specific sources, to check writable roots against */
  specific: string[];
}

export const TEMP_AREAS = [
  ...SYSTEM_TEMP_ROOTS,
  "/var/folders",
  "/private/var/folders",
];
export const GLOB_META = /[*?[\]{}]/;

export function dedupeSorted(list: Iterable<string>): string[] {
  return [...new Set(list)].sort();
}

export function underOrEqual(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

export function aliases(p: string, platform: Acc["platform"]): string[] {
  if (platform !== "macos") return [p];
  const out = [p];
  for (const a of MACOS_PRIVATE_ALIASED) {
    if (underOrEqual(p, a)) out.push(`/private${p}`);
    if (underOrEqual(p, `/private${a}`)) out.push(p.slice("/private".length));
  }
  return out;
}

export function put(
  acc: Acc,
  effect: SandboxEffect,
  entries: string[],
  source: SandboxSource,
  from: string,
  note?: string,
): void {
  const isFs =
    effect === "denyRead" ||
    effect === "denyWrite" ||
    effect === "allowRead" ||
    effect === "allowWrite";
  const full = isFs
    ? entries.flatMap((e) => aliases(e, acc.platform))
    : entries;
  const sorted = dedupeSorted(full);
  const target = isFs
    ? acc.fs[effect]
    : effect === "allowedDomains"
      ? acc.allowed
      : acc.denied;
  for (const e of sorted) target.add(e);
  if (
    isFs &&
    (source === "deny-rule" ||
      source === "protected-secret" ||
      source === "protected-config" ||
      source === "locked-path" ||
      source === "own-config") &&
    effect !== "allowRead" &&
    effect !== "allowWrite"
  ) {
    for (const e of sorted) if (!GLOB_META.test(e)) acc.specific.push(e);
  }
  acc.enforced.push({
    effect,
    source,
    from,
    entries: sorted,
    ...(note ? { note } : {}),
  });
}

export function conflict(acc: Acc, rule: string, why: string): void {
  acc.conflicts.push({ rule, why });
}
