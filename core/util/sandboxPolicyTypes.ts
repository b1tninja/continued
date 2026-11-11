import type { EgressSettings } from "./egressPolicy";
import type { BuiltinRuleId, PolicyLevels } from "../tools/permissions/policy";
import type { ToolPermissions } from "../tools/permissions/rules";

/**
 * Types for the policy to sandbox compiler (plans/ROADMAP.md W8a). See
 * `sandboxPolicy.ts` for what the compiler does and what it never claims.
 */

export type SandboxPlatform = "linux" | "wsl2" | "macos";

/** `open`: srt's default, the whole host readable except the denies. */
export type SandboxReadPolicy = "open" | "workspace-only";

export interface SandboxEgressInput extends EgressSettings {
  /** The model endpoint's host or URL; always reachable unless the mode is `none` */
  modelHost?: string;
  /**
   * Our egress proxy is chained behind srt (`parentProxy`, W6f) and checks every
   * resolved address, so `net:private` and the like hold. Default false: the
   * config alone relies on srt's own address guard.
   */
  addressChecksByProxy?: boolean;
}

export interface SandboxCompileInput {
  /** Absolute POSIX path on a Linux or macOS file system */
  workspace: string;
  extraWritable?: string[];
  /** A private per-run directory, never the system temp root */
  tempDir: string;
  homeDir: string;
  platform: SandboxPlatform;
  /** Recorded in the plan. Levels never change the config: floors do not move */
  levels: PolicyLevels;
  /** Built-in rules by id; absent means on */
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
  /** Only `deny` rules shape the config; `ask` and `allow` are policy */
  toolPermissions?: ToolPermissions;
  egress?: SandboxEgressInput;
  /** Override the protected path predicates (default: protectedPaths.ts) */
  protectedPredicates?: {
    isSecret: (path: string) => boolean;
    isConfig: (path: string) => boolean;
  };
  /** Extra paths to write-protect: our policy files (PR #516's selfProtect) */
  lockedPaths?: string[];
  /** Default `open` */
  readPolicy?: SandboxReadPolicy;
  /** Extra directories readable under `workspace-only` (a toolchain under home) */
  extraReadable?: string[];
  /** Also list empty placeholder files to create before start */
  precreate?: boolean;
}

export type SandboxSource =
  | "deny-rule"
  | "protected-secret"
  | "protected-config"
  | "locked-path"
  | "own-config"
  | "read-policy"
  | "platform"
  | "workspace"
  | "egress-policy"
  | "model-host";

export type SandboxEffect =
  | "denyRead"
  | "denyWrite"
  | "allowRead"
  | "allowWrite"
  | "allowedDomains"
  | "deniedDomains";

export interface EnforcedItem {
  effect: SandboxEffect;
  source: SandboxSource;
  /** The rule, list or setting it came from */
  from: string;
  entries: string[];
  note?: string;
}

export interface NotEnforcedItem {
  id: string;
  item: string;
  why: string;
  /** What we do about it, or "none" */
  mitigation: string;
}

export interface SandboxConflict {
  /** The rule or input that cannot be expressed */
  rule: string;
  why: string;
}

export interface SandboxConfig {
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: true;
    /** Always false: loopback binding bypasses the proxy */
    allowLocalBinding: false;
    /** Always empty: Linux ignores it, macOS would need a path allowlist */
    allowUnixSockets: string[];
  };
}

export interface SandboxPlan {
  ok: true;
  label: string;
  platform: SandboxPlatform;
  workspace: string;
  homeDir: string;
  readPolicy: SandboxReadPolicy;
  levels: PolicyLevels;
  config: SandboxConfig;
  enforced: EnforcedItem[];
  notEnforced: NotEnforcedItem[];
  /** Rules the permission engine decides; the OS layer does not carry them */
  policyOnly: string[];
  /** Always empty when `ok` is true */
  conflicts: SandboxConflict[];
  warnings: string[];
  /** Weaker modes in force; any entry means "not contained" */
  weakened: string[];
  /** Empty files to create before start, only if absent, never overwritten */
  precreate: string[];
}

export interface SandboxPlanFailure {
  ok: false;
  reasons: string[];
  conflicts: SandboxConflict[];
  warnings: string[];
}

export type SandboxCompileResult = SandboxPlan | SandboxPlanFailure;
