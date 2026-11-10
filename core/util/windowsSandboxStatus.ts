import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Whether Windows Sandbox (`wsb.exe`) could run on this machine, and what to
 * tell the person when it cannot (plans/isolation.md, W9). The same shape as
 * `containerStatus` and `wslStatus`.
 *
 * Nothing is started and nothing is installed: the CLI is looked for on PATH
 * and in System32, the edition and build come from the registry, and
 * virtualization from one CIM query. The sandbox itself is only started by the
 * timing probe, on an explicit flag. Every reader is injectable, so the tests
 * need no Windows.
 */
export type WindowsSandboxProblem =
  /** Windows Home has no Windows Sandbox */
  | "edition"
  /** `wsb` needs Windows 11 24H2 (build 26100) or newer */
  | "build"
  /** Virtualization is off in firmware, or no hypervisor is present */
  | "virtualization";

export type WindowsSandboxStatus =
  /** Not Windows: there is no Windows Sandbox to offer */
  | { state: "unsupported-platform" }
  /** `wsb.exe` was not found */
  | { state: "not-installed"; edition?: string; build?: number }
  /** `wsb.exe` is there but this machine cannot run it */
  | {
      state: "installed-but-unusable";
      wsbPath: string;
      edition?: string;
      build?: number;
      problems: WindowsSandboxProblem[];
    }
  | { state: "ready"; wsbPath: string; edition: string; build: number };

/** First build with the `wsb` command line (Windows 11 24H2). */
export const WSB_MIN_BUILD = 26100;

/** Editions that ship Windows Sandbox; Home (`Core`) does not. */
const SUPPORTED_EDITION =
  /^(Professional|ProfessionalN|ProfessionalEducation|ProfessionalWorkstation|Enterprise|EnterpriseN|EnterpriseS|Education|EducationN|ServerRdsh|IoTEnterprise)$/i;

export function isSupportedEdition(editionId: string): boolean {
  return SUPPORTED_EDITION.test(editionId);
}

/** The readers a status needs; each returns undefined when it cannot tell. */
export interface WindowsSandboxReaders {
  /** Full path of `wsb.exe` on PATH or in System32 */
  findWsb(): string | undefined;
  /** `EditionID` from the registry, e.g. "Professional", "Core" */
  readEdition(): string | undefined;
  /** `CurrentBuildNumber` from the registry */
  readBuild(): number | undefined;
  /** Whether virtualization is enabled (firmware or a running hypervisor) */
  readVirtualization(): boolean | undefined;
}

const NT = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

function reg(name: string): string | undefined {
  try {
    const out = execFileSync("reg.exe", ["query", NT, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new RegExp(`${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im").exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * `fs.existsSync` is false for an app execution alias (the `wsb.exe` under
 * `...\WindowsApps` is one, a reparse point `stat` cannot follow), `lstat` is not.
 */
function existsOrAlias(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The path of `wsb.exe` among the given directories (PATH, then System32). */
export function locateWsb(
  pathVar: string,
  systemRoot: string,
  exists: (p: string) => boolean = existsOrAlias,
): string | undefined {
  const dirs = [
    ...pathVar.split(";").filter(Boolean),
    path.win32.join(systemRoot, "System32"),
  ];
  for (const dir of dirs) {
    const candidate = path.win32.join(dir, "wsb.exe");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function parseVirtualization(output: string): boolean | undefined {
  const values = output
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l === "true" || l === "false");
  if (values.length === 0) return undefined;
  return values.includes("true");
}

const realReaders: WindowsSandboxReaders = {
  findWsb: () =>
    locateWsb(process.env.PATH ?? "", process.env.SystemRoot ?? "C:\\Windows"),
  readEdition: () => reg("EditionID"),
  readBuild: () => {
    const n = Number.parseInt(reg("CurrentBuildNumber") ?? "", 10);
    return Number.isFinite(n) ? n : undefined;
  },
  // A running hypervisor means virtualization is on; the firmware flag is
  // only reported while none is running. Read-only: starts nothing.
  readVirtualization: () => {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent; (Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return parseVirtualization(out);
    } catch {
      return undefined;
    }
  },
};

let cache: { at: number; status: WindowsSandboxStatus } | undefined;

export function resetWindowsSandboxStatusCache(): void {
  cache = undefined;
}

export function windowsSandboxStatus(
  opts: {
    platform?: NodeJS.Platform;
    readers?: Partial<WindowsSandboxReaders>;
    now?: number;
  } = {},
): WindowsSandboxStatus {
  if ((opts.platform ?? process.platform) !== "win32") {
    return { state: "unsupported-platform" };
  }
  const now = opts.now ?? Date.now();
  if (!opts.readers && cache && now - cache.at < 10_000) return cache.status;

  const r = { ...realReaders, ...opts.readers };
  const edition = r.readEdition();
  const build = r.readBuild();
  const wsbPath = r.findWsb();

  let status: WindowsSandboxStatus;
  if (!wsbPath) {
    status = { state: "not-installed", edition, build };
  } else {
    const problems: WindowsSandboxProblem[] = [];
    if (edition !== undefined && !isSupportedEdition(edition)) {
      problems.push("edition");
    }
    if (build !== undefined && build < WSB_MIN_BUILD) problems.push("build");
    // Unknown is not a problem: the probe says what really happens
    if (r.readVirtualization() === false) problems.push("virtualization");
    status =
      problems.length > 0
        ? { state: "installed-but-unusable", wsbPath, edition, build, problems }
        : {
            state: "ready",
            wsbPath,
            edition: edition ?? "unknown",
            build: build ?? 0,
          };
  }
  if (!opts.readers) cache = { at: now, status };
  return status;
}

/** What to do to get Windows Sandbox; shown to the person, never run for them. */
export const WSB_ENABLE_HINT =
  "Enable the 'Windows Sandbox' optional feature (an administrator PowerShell: `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`), then restart. It needs Windows 11 24H2 or newer, Pro, Enterprise or Education, with virtualization enabled in firmware.";

/**
 * The sentence for a status that is not ready, or undefined when it is. It
 * says how to get Windows Sandbox and never does it for the person.
 */
export function windowsSandboxUnavailableMessage(
  status: WindowsSandboxStatus,
): string | undefined {
  switch (status.state) {
    case "ready":
      return undefined;
    case "unsupported-platform":
      return "Windows Sandbox is only available on Windows.";
    case "not-installed":
      return `Windows Sandbox (wsb.exe) was not found. ${WSB_ENABLE_HINT}`;
    case "installed-but-unusable": {
      const why = status.problems.map((p) =>
        p === "edition"
          ? `this edition (${status.edition}) does not include it; it needs Pro, Enterprise or Education`
          : p === "build"
            ? `this Windows build (${status.build}) is older than ${WSB_MIN_BUILD} (Windows 11 24H2)`
            : "virtualization is not enabled (turn it on in firmware, and enable the Virtual Machine Platform)",
      );
      return `Windows Sandbox cannot run here: ${why.join("; ")}.`;
    }
  }
}
