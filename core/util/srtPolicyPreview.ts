import type { SrtHostKind } from "./srtStatus";

/**
 * The srt configuration Continuous WOULD pass, as data (plans/ROADMAP.md W4a).
 *
 * This is a PREVIEW. Nothing here is applied, nothing is sandboxed, and srt is
 * never imported or run. The shape is srt's `SandboxRuntimeConfig` subset we
 * would use (network allowlist plus filesystem lists), built from a closed
 * TypeScript type: srt silently ignores unknown top-level keys, so a typo'd
 * `denyWrite` fails open there (srt issue #434) and must not be possible here.
 *
 * It also lists what srt does NOT cover, because the spike measured each of
 * them leaking through the srt defaults.
 */

export interface SrtPolicySettings {
  /** The model endpoint's host: the only network destination by default */
  modelHost?: string;
  /** Extra hosts the person allowed (a package registry, say) */
  extraAllowedDomains?: string[];
  /**
   * `credentials` (default): deny a list of secret locations; everything else
   * stays readable, as srt's default is allow-by-default for reads.
   * `workspace-only`: deny the home and mount roots, allow the workspace.
   */
  readPolicy?: "credentials" | "workspace-only";
  /** The host kind from `detectSrt`; `wsl2` adds the `/mnt` read deny */
  hostKind?: SrtHostKind;
}

export interface SrtDenyWriteEntry {
  path: string;
  /** Whether srt's own mandatory deny list already names it */
  inSrtMandatoryList: boolean;
  why: string;
}

export interface SrtNotCovered {
  item: string;
  /** What the srt defaults do, as measured or read */
  srtDefault: string;
  /** What we do about it; none of it is applied by this slice */
  ourMitigation: string;
}

export interface SrtPolicyPreview {
  /** Always true: this is not applied */
  preview: true;
  applied: false;
  label: string;
  /** The config object we would pass to `SandboxManager.initialize` */
  config: {
    network: {
      allowedDomains: string[];
      deniedDomains: string[];
      strictAllowlist: true;
    };
    filesystem: {
      denyRead: string[];
      allowRead: string[];
      allowWrite: string[];
      denyWrite: string[];
    };
  };
  /** Weaker srt modes we never enable; always empty */
  weakened: [];
  /** The deny-write list with where each entry comes from */
  denyWriteSources: SrtDenyWriteEntry[];
  /** How files created after the sandbox starts are handled */
  createdLater: string;
  notCovered: SrtNotCovered[];
  notes: string[];
}

/** srt's DANGEROUS_FILES and dangerous directories (v0.0.82, read from source). */
const SRT_MANDATORY = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
  ".git/hooks",
  ".git/config",
  ".claude/commands",
  ".claude/agents",
]);

const DENY_WRITE: ReadonlyArray<readonly [string, string]> = [
  [".envrc", "direnv runs it on cd, outside the jail"],
  [".husky", "git hooks the host runs on commit"],
  [".continuous", "our own project config: hooks, rules, MCP servers"],
  [".git/hooks", "the host's git runs these"],
  [".git/config", "can name a core.fsmonitor or hook program the host runs"],
  [".vscode", "tasks and settings the editor runs"],
  [".idea", "run configurations the editor runs"],
  [".mcp.json", "MCP servers the host starts"],
  [".bashrc", "shell rc file, run by the next login shell"],
  [".bash_profile", "shell rc file"],
  [".zshrc", "shell rc file"],
  [".zprofile", "shell rc file"],
  [".profile", "shell rc file"],
  [".gitconfig", "git configuration"],
  [".gitmodules", "submodule URLs"],
  [".ripgreprc", "ripgrep reads it on every run"],
];

/** Where secrets usually live in a home directory; srt expands `~`. */
export const SECRET_DENY_READ: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.azure",
  "~/.kube",
  "~/.docker",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.npmrc",
  "~/.netrc",
  "~/.git-credentials",
  "~/.continue",
  "~/.continuous",
];

const BROAD_DENY_READ: readonly string[] = [
  "/home",
  "/root",
  "/mnt",
  "/run",
  "/var/run",
];

function join(workspace: string, rel: string): string {
  const sep = workspace.includes("\\") ? "\\" : "/";
  const base = workspace.replace(/[\\/]+$/, "");
  return `${base}${sep}${rel.split("/").join(sep)}`;
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  try {
    return new URL(trimmed).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

function networkAllowlist(settings: SrtPolicySettings): string[] {
  const hosts = [
    ...(settings.modelHost ? [settings.modelHost] : []),
    ...(settings.extraAllowedDomains ?? []),
  ]
    .map(normalizeHost)
    .filter(Boolean);
  return [...new Set(hosts)];
}

function readLists(settings: SrtPolicySettings, workspace: string) {
  const wsl2 = settings.hostKind === "wsl2";
  if (settings.readPolicy === "workspace-only") {
    return { denyRead: [...BROAD_DENY_READ], allowRead: [workspace] };
  }
  return {
    denyRead: [...SECRET_DENY_READ, ...(wsl2 ? ["/mnt"] : [])],
    allowRead: [],
  };
}

const NOT_COVERED: SrtNotCovered[] = [
  {
    item: "/mnt/c and the other Windows drives under WSL2",
    srtDefault:
      "readable inside the jail (measured: `ls /mnt/c/Users` and `C:\\Windows\\win.ini` were readable); a write to /mnt/d gave a read-only error",
    ourMitigation:
      "the preview denies /mnt on WSL2, but the deny list is built when a command is wrapped; the strong form is a dedicated distribution with `[automount] enabled=false`, `[interop] enabled=false` and `appendWindowsPath=false` (W9)",
  },
  {
    item: "host environment variables",
    srtDefault:
      "not scrubbed (measured: a host variable was visible inside the jail, as were HOME and WSL_INTEROP)",
    ourMitigation:
      "terminalEnvironment() must build the environment before srt wraps the command (core/util/terminalEnvironment.ts, `continuous terminal-env show`); srt does not do it",
  },
  {
    item: "WSL interop and the Windows PATH",
    srtDefault:
      "WSL_INTEROP and Windows PATH entries stay in the environment; `cmd.exe` failed in the jail only because the seccomp AF_VSOCK rule blocks it, which is not a designed WSL control",
    ourMitigation:
      "scrub the environment, and use the dedicated-distribution form with interop disabled",
  },
  {
    item: "resource limits",
    srtDefault: "none documented (no cgroup, pids or memory limit)",
    ourMitigation: "none planned in srt; the container executor sets them",
  },
  {
    item: "network beyond the domain allowlist",
    srtDefault:
      "domain level only: no traffic inspection, domain fronting may pass, and an allowed host such as github.com allows exfiltration to any repository there",
    ourMitigation:
      "keep the list to the model host; route through our egress proxy as parentProxy in a later slice (W6f)",
  },
  {
    item: "host tools that trust files the jailed command made",
    srtDefault:
      "the jail does not stop a confused deputy: a symlink or config file made inside is later followed or run by an unjailed host component",
    ourMitigation:
      "policy in the host file tools (W8b); the deny-write list narrows this and cannot close it",
  },
];

/**
 * The config we would pass to srt for this workspace. Pure: no file is read,
 * nothing is checked on disk, and nothing is applied. `workspace` should be an
 * absolute path on a Linux file system.
 */
export function effectivePolicyPreview(
  settings: SrtPolicySettings,
  workspace: string,
): SrtPolicyPreview {
  const allowedDomains = networkAllowlist(settings);
  const denyWriteSources = DENY_WRITE.map(([rel, why]) => ({
    path: join(workspace, rel),
    inSrtMandatoryList: SRT_MANDATORY.has(rel),
    why,
  }));
  const notes: string[] = [
    "PREVIEW ONLY: nothing here is applied and no command is sandboxed.",
  ];
  if (allowedDomains.length === 0) {
    notes.push(
      "No model host was given, so the network allowlist is empty: no network at all.",
    );
  }
  if (
    /^\/mnt\/[a-z](\/|$)/i.test(workspace) ||
    /^[A-Za-z]:[\\/]/.test(workspace)
  ) {
    notes.push(
      "The workspace is on a Windows drive. srt needs it on the Linux file system: a 9p drive makes every folder look writable, and srt creates mount points on it itself.",
    );
  }
  return {
    preview: true,
    applied: false,
    label: "PREVIEW: the srt config Continuous would pass; not applied",
    config: {
      network: { allowedDomains, deniedDomains: [], strictAllowlist: true },
      filesystem: {
        ...readLists(settings, workspace),
        allowWrite: [workspace],
        denyWrite: denyWriteSources.map((e) => e.path),
      },
    },
    weakened: [],
    denyWriteSources,
    createdLater:
      "srt builds its deny mounts when it wraps a command. A path that is absent then (no .git yet, no .husky yet) or that a command creates in a subdirectory later is NOT protected: srt scans to depth 3 (measured: `sub/.vscode/tasks.json` and `a/b/c/d/e/.bashrc` were written inside the jail, and `.git/hooks/pre-commit` was written when no `.git` existed). The entries above are absolute and top-level only, so they close the known names at the workspace root and nothing more. Files a jailed command creates must be treated as untrusted by host tools until a later slice verifies it (W7h, W8b).",
    notCovered: NOT_COVERED,
    notes,
  };
}
