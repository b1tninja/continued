import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Whether `@anthropic-ai/sandbox-runtime` (srt) could run on this machine, and
 * what is missing when it could not (plans/ROADMAP.md W4a). The same shape as
 * `windowsSandboxStatus`, `wslStatus` and `devcontainer`'s CLI status.
 *
 * This is a STATUS PROBE and nothing else. It reads files, looks programs up on
 * PATH and runs `--version` style probes (`bwrap --version`, `socat -V`,
 * `rg --version`), each with a short timeout. It never runs `srt`, never starts
 * a sandbox, never imports srt code, installs nothing and uses no network.
 * Every reader is injectable, so the tests need no Linux, macOS or WSL.
 *
 * `ready` means: the dependencies were found, they answered a version probe,
 * and no known kernel policy blocks user namespaces. It does NOT mean that
 * anything is contained, and no field here ever says so (`containment` is the
 * literal "not-verified"). An unreadable fact stays `unknown`, and `unknown`
 * never becomes `ready` (see `SandboxState`).
 */

/** The srt version the spike measured; what the install fix names. */
export const SRT_PINNED_VERSION = "0.0.82";
export const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
/** srt's `engines.node` */
export const SRT_MIN_NODE = "22.12.0";
/** srt warns (does not refuse) below this: special-file denies need it */
export const SRT_BWRAP_FULL_SUPPORT = "0.5.0";
/** srt supports bubblewrap from here; older is treated as missing */
export const SRT_BWRAP_MIN = "0.4.0";

export type SrtVerdict = "ready" | "missing" | "unsupported" | "unknown";

/** What kind of host this is for srt's purposes. */
export type SrtHostKind =
  "linux" | "wsl2" | "wsl1" | "macos" | "windows" | "other";

export type SrtItemId =
  | "node"
  | "srt"
  | "bwrap"
  | "socat"
  | "ripgrep"
  | "sandbox-exec"
  | "user-namespaces"
  | "seccomp"
  | "wsl-generation";

/**
 * - `present`: found, and the version probe (if any) answered
 * - `missing`: not found
 * - `broken`: found on PATH but the version probe failed (e.g. socat that
 *   cannot load libssl, which the spike measured)
 * - `too-old`: found, below the supported version
 * - `blocked`: a read policy says it cannot work
 * - `unknown`: the fact could not be read
 */
export type SrtCheckState =
  "present" | "missing" | "broken" | "too-old" | "blocked" | "unknown";

export interface SrtCheck {
  id: SrtItemId;
  state: SrtCheckState;
  version?: string;
  path?: string;
  /** What was read, for the person */
  detail?: string;
}

export interface SrtMissingItem {
  item: SrtItemId;
  state: Exclude<SrtCheckState, "present">;
  why: string;
  /** One line, shown to the person and never run for them */
  fix: string;
}

export interface SrtStatus {
  verdict: SrtVerdict;
  host: {
    platform: string;
    arch: string;
    kind: SrtHostKind;
    /** Whether srt has a backend we would use on this host */
    supported: boolean;
    /** Why not, when unsupported */
    reason?: string;
  };
  checks: SrtCheck[];
  /** Definite problems (missing, broken, too old, blocked), each with a fix */
  missing: SrtMissingItem[];
  /** Facts that could not be read or are only conditionally fine */
  unknown: SrtMissingItem[];
  /** Things that work but are weaker than they should be */
  warnings: string[];
  /** This probe never verifies containment */
  containment: "not-verified";
}

/** The readers a status needs; each returns undefined when it cannot tell. */
export interface SrtReaders {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  /** Full path of an executable on PATH */
  which(name: string): string | undefined;
  /** stdout of a version probe (`bwrap --version`); undefined when it fails */
  probeVersion(file: string, args: string[]): string | undefined;
  /** Contents of a small text file (`/proc/...`, `/etc/os-release`) */
  readFile(file: string): string | undefined;
  /** An environment variable */
  getenv(name: string): string | undefined;
  /** The srt npm package if it can be resolved: read from its package.json, never run */
  readSrtPackage(): { path: string; version?: string } | undefined;
}

// ---------------------------------------------------------------------------
// Version helpers

/** The first dotted number in `text` after an optional marker. */
export function parseVersion(
  text: string,
  marker?: RegExp,
): string | undefined {
  const from = marker ? text.search(marker) : 0;
  if (from < 0) return undefined;
  return /\d+(?:\.\d+)+/.exec(text.slice(from))?.[0];
}

/** Negative when a < b. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Real readers

function whichOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

const realReaders: SrtReaders = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.versions.node,
  which: whichOnPath,
  probeVersion: (file, args) => {
    try {
      return execFileSync(file, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return undefined;
    }
  },
  readFile: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  getenv: (name) => process.env[name],
  readSrtPackage: () => {
    try {
      const req = createRequire(path.join(process.cwd(), "noop.js"));
      const pkgPath = req.resolve(`${SRT_PACKAGE}/package.json`);
      const version = (
        JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string }
      ).version;
      return { path: path.dirname(pkgPath), version };
    } catch {
      return undefined;
    }
  },
};

// ---------------------------------------------------------------------------
// Host

function hostKind(r: SrtReaders): { kind: SrtHostKind; wslUnknown: boolean } {
  switch (r.platform) {
    case "win32":
      return { kind: "windows", wslUnknown: false };
    case "darwin":
      return { kind: "macos", wslUnknown: false };
    case "linux": {
      const version = r.readFile("/proc/version");
      const viaEnv = !!(r.getenv("WSL_DISTRO_NAME") || r.getenv("WSL_INTEROP"));
      if (version !== undefined && /microsoft/i.test(version)) {
        // WSL2 kernels say "microsoft-standard-WSL2"; WSL1 says "...-Microsoft"
        return {
          kind: /WSL2|microsoft-standard/i.test(version) ? "wsl2" : "wsl1",
          wslUnknown: false,
        };
      }
      if (version === undefined && viaEnv) {
        return { kind: "wsl2", wslUnknown: true };
      }
      return { kind: "linux", wslUnknown: false };
    }
    default:
      return { kind: "other", wslUnknown: false };
  }
}

const UNSUPPORTED_REASON: Partial<Record<SrtHostKind, string>> = {
  windows:
    "srt's native Windows backend is alpha (it needs an elevated install, machine-wide firewall filters and a local user). The routes here are WSL2 (srt inside a distribution) or the Windows Sandbox runner.",
  wsl1: "WSL1 has no user namespaces for bubblewrap. srt supports WSL2 only; convert the distribution with `wsl --set-version <name> 2`.",
  other: "srt has backends for Linux, WSL2 and macOS only.",
};

// ---------------------------------------------------------------------------
// Fix lines

type PackageManager = "apt" | "dnf" | "pacman" | "apk" | "zypper" | "unknown";

function packageManager(osRelease: string | undefined): PackageManager {
  const ids = [
    /^ID=(.*)$/m.exec(osRelease ?? "")?.[1],
    /^ID_LIKE=(.*)$/m.exec(osRelease ?? "")?.[1],
  ]
    .join(" ")
    .toLowerCase();
  if (/debian|ubuntu/.test(ids)) return "apt";
  if (/fedora|rhel|centos/.test(ids)) return "dnf";
  if (/arch/.test(ids)) return "pacman";
  if (/alpine/.test(ids)) return "apk";
  if (/suse/.test(ids)) return "zypper";
  return "unknown";
}

/** The command that installs `pkg` (packages share names across the common distros). */
export function installCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case "apt":
      return `sudo apt-get install -y ${pkg}`;
    case "dnf":
      return `sudo dnf install -y ${pkg}`;
    case "pacman":
      return `sudo pacman -S --needed ${pkg}`;
    case "apk":
      return `sudo apk add ${pkg}`;
    case "zypper":
      return `sudo zypper install ${pkg}`;
    default:
      return `install the "${pkg}" package with your distribution's package manager`;
  }
}

export const SRT_INSTALL_FIX = `npm install --save-exact --omit=optional --ignore-scripts ${SRT_PACKAGE}@${SRT_PINNED_VERSION}, in a directory outside every folder a command may write (not the workspace's node_modules)`;

// ---------------------------------------------------------------------------
// Checks

function binaryCheck(
  r: SrtReaders,
  id: SrtItemId,
  bin: string,
  args: string[],
  marker: RegExp,
  min?: string,
): SrtCheck {
  const file = r.which(bin);
  if (!file) return { id, state: "missing" };
  const out = r.probeVersion(file, args);
  if (out === undefined) {
    return {
      id,
      state: "broken",
      path: file,
      detail: `\`${bin} ${args.join(" ")}\` failed`,
    };
  }
  const version = parseVersion(out, marker);
  if (min && version && compareVersions(version, min) < 0) {
    return { id, state: "too-old", path: file, version };
  }
  return { id, state: "present", path: file, version };
}

function nodeCheck(r: SrtReaders): SrtCheck {
  return {
    id: "node",
    state:
      compareVersions(r.nodeVersion, SRT_MIN_NODE) < 0 ? "too-old" : "present",
    version: r.nodeVersion,
    detail: "the Node running this probe; srt needs it too",
  };
}

function srtCheck(r: SrtReaders): SrtCheck {
  const pkg = r.readSrtPackage();
  if (pkg) {
    return {
      id: "srt",
      state: "present",
      path: pkg.path,
      version: pkg.version,
      detail:
        "npm package resolved; its package.json was read, srt was not run",
    };
  }
  const cli = r.which("srt");
  if (cli) {
    return {
      id: "srt",
      state: "present",
      path: cli,
      detail:
        "`srt` found on PATH; its version was not probed (srt is never run here)",
    };
  }
  return { id: "srt", state: "missing" };
}

/** The userns facts: a read policy, not a test that bwrap works. */
export function usernsCheck(r: SrtReaders): SrtCheck {
  const clone = r
    .readFile("/proc/sys/kernel/unprivileged_userns_clone")
    ?.trim();
  const max = r.readFile("/proc/sys/user/max_user_namespaces")?.trim();
  const restrict = r
    .readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    ?.trim();
  const facts = [
    clone !== undefined && `unprivileged_userns_clone=${clone}`,
    max !== undefined && `max_user_namespaces=${max}`,
    restrict !== undefined &&
      `apparmor_restrict_unprivileged_userns=${restrict}`,
  ].filter(Boolean);
  const detail = facts.length
    ? facts.join(", ")
    : "no policy file could be read";
  if (clone === "0" || max === "0")
    return { id: "user-namespaces", state: "blocked", detail };
  if (restrict === "1") {
    // Allowed but stripped of capabilities, unless an AppArmor profile permits bwrap
    return {
      id: "user-namespaces",
      state: "unknown",
      detail: `${detail} (restricted)`,
    };
  }
  const maxOk = max !== undefined && Number.parseInt(max, 10) > 0;
  if (clone === "1" || (clone === undefined && maxOk)) {
    return { id: "user-namespaces", state: "present", detail };
  }
  return { id: "user-namespaces", state: "unknown", detail };
}

/** srt bundles `apply-seccomp` for x64 and arm64; the kernel needs seccomp. */
export function seccompCheck(r: SrtReaders): SrtCheck {
  if (r.arch !== "x64" && r.arch !== "arm64") {
    return {
      id: "seccomp",
      state: "blocked",
      detail: `srt bundles its seccomp helper for x64 and arm64, not ${r.arch}`,
    };
  }
  const status = r.readFile("/proc/self/status");
  if (status === undefined) {
    return {
      id: "seccomp",
      state: "unknown",
      detail: "/proc/self/status not readable",
    };
  }
  return /^Seccomp:/m.test(status)
    ? {
        id: "seccomp",
        state: "present",
        detail: `kernel reports seccomp; helper bundled for ${r.arch}`,
      }
    : {
        id: "seccomp",
        state: "blocked",
        detail: "the kernel reports no seccomp support",
      };
}

function linuxChecks(r: SrtReaders): SrtCheck[] {
  return [
    nodeCheck(r),
    srtCheck(r),
    binaryCheck(
      r,
      "bwrap",
      "bwrap",
      ["--version"],
      /bubblewrap/i,
      SRT_BWRAP_MIN,
    ),
    binaryCheck(r, "socat", "socat", ["-V"], /socat version/i),
    binaryCheck(r, "ripgrep", "rg", ["--version"], /ripgrep/i),
    usernsCheck(r),
    seccompCheck(r),
  ];
}

function macosChecks(r: SrtReaders): SrtCheck[] {
  const sandboxExec = r.which("sandbox-exec");
  return [
    nodeCheck(r),
    srtCheck(r),
    sandboxExec
      ? { id: "sandbox-exec", state: "present", path: sandboxExec }
      : { id: "sandbox-exec", state: "missing" },
    binaryCheck(r, "ripgrep", "rg", ["--version"], /ripgrep/i),
  ];
}

// ---------------------------------------------------------------------------
// Explanations and fixes

function explain(
  check: SrtCheck,
  pm: PackageManager,
): { why: string; fix: string } {
  const v = check.version ? ` ${check.version}` : "";
  switch (check.id) {
    case "node":
      return {
        why: `Node${v} is older than ${SRT_MIN_NODE}, which srt requires`,
        fix: `install Node ${SRT_MIN_NODE} or newer (inside WSL, a Linux Node, not the Windows one)`,
      };
    case "srt":
      return {
        why: "the srt package was not found",
        fix: SRT_INSTALL_FIX,
      };
    case "bwrap": {
      const old = check.state === "too-old";
      return {
        why: old
          ? `bubblewrap${v} is older than ${SRT_BWRAP_MIN}, the oldest srt supports`
          : check.state === "broken"
            ? "bwrap is on PATH but `bwrap --version` failed"
            : "bubblewrap (bwrap) was not found",
        fix: installCommand(pm, "bubblewrap"),
      };
    }
    case "socat":
      return {
        why:
          check.state === "broken"
            ? "socat is on PATH but `socat -V` failed, often a missing shared library such as libssl; srt's network bridge cannot start with it"
            : "socat was not found; srt needs it for the network bridge",
        fix:
          check.state === "broken"
            ? `reinstall socat so it matches the installed OpenSSL: ${installCommand(pm, "socat")}`
            : installCommand(pm, "socat"),
      };
    case "ripgrep":
      return {
        why:
          check.state === "broken"
            ? "rg is on PATH but `rg --version` failed"
            : "ripgrep (rg) was not found; srt uses it to find paths to protect",
        fix: installCommand(pm, "ripgrep"),
      };
    case "sandbox-exec":
      return {
        why: "sandbox-exec was not found (macOS ships /usr/bin/sandbox-exec)",
        fix: "restore /usr/bin/sandbox-exec; it is part of macOS and cannot be installed separately",
      };
    case "user-namespaces":
      return check.state === "blocked"
        ? {
            why: `unprivileged user namespaces are disabled (${check.detail})`,
            fix: "sudo sysctl -w kernel.unprivileged_userns_clone=1 (Debian) and raise user.max_user_namespaces above 0",
          }
        : {
            why: `user namespaces are restricted by AppArmor (${check.detail}); bubblewrap may fail unless a profile permits it. Not tested here.`,
            fix: "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (or an AppArmor profile that grants userns to bwrap)",
          };
    case "seccomp":
      return check.state === "blocked"
        ? {
            why: check.detail ?? "seccomp is not available",
            fix: "no fix here: use an x64 or arm64 host with a seccomp-enabled kernel",
          }
        : {
            why: "could not read the kernel's seccomp support",
            fix: "run `grep Seccomp /proc/self/status`; a `Seccomp:` line means the kernel supports it",
          };
    case "wsl-generation":
      return {
        why: "this looks like WSL but /proc/version could not be read, so WSL1 versus WSL2 is unknown",
        fix: "run `wsl -l -v` on Windows; srt needs WSL2",
      };
  }
}

function toItems(checks: SrtCheck[], pm: PackageManager) {
  const missing: SrtMissingItem[] = [];
  const unknown: SrtMissingItem[] = [];
  for (const c of checks) {
    if (c.state === "present") continue;
    const item: SrtMissingItem = {
      item: c.id,
      state: c.state,
      ...explain(c, pm),
    };
    (c.state === "unknown" ? unknown : missing).push(item);
  }
  return { missing, unknown };
}

function warningsFor(checks: SrtCheck[]): string[] {
  const warnings: string[] = [];
  const bwrap = checks.find((c) => c.id === "bwrap");
  if (
    bwrap?.state === "present" &&
    bwrap.version &&
    compareVersions(bwrap.version, SRT_BWRAP_FULL_SUPPORT) < 0
  ) {
    warnings.push(
      `bubblewrap ${bwrap.version} is older than ${SRT_BWRAP_FULL_SUPPORT}: srt works, but a read deny on a fifo, socket or device node cannot be applied`,
    );
  }
  return warnings;
}

/**
 * What srt could do here, from facts that were read or from version probes.
 *
 * Verdict, in order:
 * 1. `unsupported`: native Windows, WSL1 or another platform (no checks are made)
 * 2. `missing`: any check is missing, broken, too old or blocked
 * 3. `unknown`: no check is missing, but some fact could not be read (or is only
 *    conditionally fine, such as AppArmor-restricted user namespaces)
 * 4. `ready`: every check is present
 */
export function detectSrt(readers: Partial<SrtReaders> = {}): SrtStatus {
  const r: SrtReaders = { ...realReaders, ...readers };
  const { kind, wslUnknown } = hostKind(r);
  const host = {
    platform: r.platform,
    arch: r.arch,
    kind,
    supported: kind === "linux" || kind === "wsl2" || kind === "macos",
    reason: UNSUPPORTED_REASON[kind],
  };
  const base = {
    host,
    checks: [],
    missing: [],
    unknown: [],
    warnings: [],
    containment: "not-verified" as const,
  };
  if (!host.supported) return { ...base, verdict: "unsupported" };

  const checks =
    kind === "macos"
      ? macosChecks(r)
      : [
          ...(wslUnknown
            ? [{ id: "wsl-generation", state: "unknown" } as SrtCheck]
            : []),
          ...linuxChecks(r),
        ];
  const pm =
    kind === "macos"
      ? "unknown"
      : packageManager(r.readFile("/etc/os-release"));
  const { missing, unknown } = toItems(checks, pm);
  const verdict: SrtVerdict = missing.length
    ? "missing"
    : unknown.length
      ? "unknown"
      : "ready";
  return {
    ...base,
    verdict,
    checks,
    missing,
    unknown,
    warnings: warningsFor(checks),
  };
}

// ---------------------------------------------------------------------------
// Fail closed

/**
 * What the rest of the code may believe about srt. Built ONLY from our own
 * probe result, never from srt: in the spike, `SandboxManager.isSandboxingEnabled()`
 * and `getConfig()` stayed truthy after `initialize()` threw (missing socat),
 * and `wrapWithSandbox()` still returned a `bwrap ...` string. So those getters
 * are not evidence of anything and must not feed this type.
 *
 * `probed-ready` is deliberately not "contained": it says the probe found
 * nothing missing, which is weaker than any property a later slice may verify.
 */
export type SandboxState =
  | { state: "unavailable"; reason: string }
  | { state: "probed-ready"; containment: "not-verified" };

/** Anything but a clean `ready` probe is unavailable: undefined, an error, unknown, missing, unsupported. */
export function sandboxStateFromProbe(
  probe: SrtStatus | Error | undefined | null,
): SandboxState {
  if (probe === undefined || probe === null) {
    return { state: "unavailable", reason: "the status probe has not run" };
  }
  if (probe instanceof Error) {
    return {
      state: "unavailable",
      reason: `the status probe failed: ${probe.message}`,
    };
  }
  if (probe.verdict !== "ready") {
    return {
      state: "unavailable",
      reason: `the status probe says ${probe.verdict}`,
    };
  }
  return { state: "probed-ready", containment: "not-verified" };
}

/** `detectSrt` that turns a thrown reader into an unavailable state. */
export function probeSandboxState(
  readers: Partial<SrtReaders> = {},
): SandboxState {
  try {
    return sandboxStateFromProbe(detectSrt(readers));
  } catch (e) {
    return sandboxStateFromProbe(e instanceof Error ? e : new Error(String(e)));
  }
}
