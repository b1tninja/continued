import fs from "node:fs";
import path from "node:path";

/**
 * Pure helpers for running a command in Windows Sandbox and getting the result
 * back (plans/windows-sandbox-runner.md). The driver is
 * `extensions/cli/scripts/sandboxRun.ts`; everything that can be tested without
 * a sandbox lives here, with its readers injectable.
 */

/** Escape text for an XML element body. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface MappedFolder {
  host: string;
  sandbox: string;
  readOnly: boolean;
}

export interface SandboxConfigOptions {
  networking: boolean;
  folders: MappedFolder[];
}

/**
 * The `.wsb` configuration as ONE line with no double quote anywhere, the form
 * `wsb start --config "<xml>"` takes through a command line. Control characters
 * in a path are refused: they would break the one-line form.
 */
export function buildSandboxConfig(opts: SandboxConfigOptions): string {
  const folders = opts.folders
    .map((f) => {
      for (const p of [f.host, f.sandbox]) {
        if (!p) throw new Error("Empty mapped path");
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f]/.test(p)) {
          throw new Error(
            `Control character in mapped path: ${JSON.stringify(p)}`,
          );
        }
      }
      return (
        `<MappedFolder><HostFolder>${escapeXml(f.host)}</HostFolder>` +
        `<SandboxFolder>${escapeXml(f.sandbox)}</SandboxFolder>` +
        `<ReadOnly>${f.readOnly ? "true" : "false"}</ReadOnly></MappedFolder>`
      );
    })
    .join("");
  return (
    `<Configuration><VGpu>Disable</VGpu>` +
    `<Networking>${opts.networking ? "Default" : "Disable"}</Networking>` +
    `<MappedFolders>${folders}</MappedFolders></Configuration>`
  );
}

export const RESULT_FILES = {
  exit: "exit.txt",
  stdout: "stdout.txt",
  stderr: "stderr.txt",
  done: "DONE",
} as const;

/**
 * The text of a `.cmd` file that runs `command` in the payload folder and
 * writes the result protocol into the out share: stdout.txt, stderr.txt, then
 * exit.txt, and last the DONE marker (so DONE implies the others are final).
 * `command` is cmd.exe syntax; `%` must be written `%%` in a batch file.
 */
export function buildRunnerCmd(opts: {
  command: string;
  payloadDir: string;
  outDir: string;
  nodeDir?: string;
}): string {
  const o = opts.outDir.replace(/[\\/]+$/, "");
  const lines = ["@echo off"];
  if (opts.nodeDir) lines.push(`set "PATH=${opts.nodeDir};%PATH%"`);
  lines.push(
    `cd /d "${opts.payloadDir}"`,
    "(",
    opts.command,
    `) > "${o}\\${RESULT_FILES.stdout}" 2> "${o}\\${RESULT_FILES.stderr}"`,
    // Redirection first: `echo 1> file` would redirect handle 1, not write "1"
    `>"${o}\\${RESULT_FILES.exit}" echo %errorlevel%`,
    `>"${o}\\${RESULT_FILES.done}" echo done`,
    "",
  );
  return lines.join("\r\n");
}

export interface CopyPayloadOptions {
  excludeDirs?: string[];
  maxFileBytes?: number;
}

export interface CopyPayloadReport {
  copied: { path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  totalBytes: number;
}

/**
 * Copy a payload folder with plain file operations (git cannot run in the
 * sandbox). `.git` and `node_modules` are not copied, nor files over
 * `maxFileBytes` (default 10 MB); the report lists what was and was not.
 */
export function copyPayload(
  src: string,
  dest: string,
  opts: CopyPayloadOptions = {},
): CopyPayloadReport {
  const exclude = new Set(
    (opts.excludeDirs ?? [".git", "node_modules"]).map((d) => d.toLowerCase()),
  );
  const max = opts.maxFileBytes ?? 10 * 1024 * 1024;
  const report: CopyPayloadReport = { copied: [], skipped: [], totalBytes: 0 };
  const walk = (rel: string) => {
    const dir = path.join(src, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const from = path.join(src, r);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name.toLowerCase())) {
          report.skipped.push({ path: r, reason: "excluded directory" });
        } else {
          walk(r);
        }
      } else if (entry.isFile()) {
        const bytes = fs.statSync(from).size;
        if (bytes > max) {
          report.skipped.push({ path: r, reason: `larger than ${max} bytes` });
          continue;
        }
        const to = path.join(dest, r);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        report.copied.push({ path: r, bytes });
        report.totalBytes += bytes;
      } else {
        report.skipped.push({ path: r, reason: "not a regular file" });
      }
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walk("");
  return report;
}

export interface VpnReaders {
  /** Names of running processes, e.g. `NordVPN.exe` */
  processes(): string[];
  /** Network adapters with their state */
  adapters(): { name: string; up: boolean }[];
}

const VPN_PROCESS =
  /^(nordvpn|nordlynx|expressvpn|protonvpn|mullvad|openvpn|windscribe|surfshark|cyberghost|pia-client)/i;
const VPN_ADAPTER =
  /nord|expressvpn|proton|mullvad|openvpn|windscribe|surfshark|wireguard|cyberghost|tap-windows/i;

export interface VpnReport {
  /** A VPN client process is running */
  clientRunning: boolean;
  /** A VPN adapter is connected: this is what has stopped the sandbox's network */
  connected: boolean;
  processes: string[];
  adapters: string[];
}

export function detectVpn(readers: VpnReaders): VpnReport {
  const processes = [
    ...new Set(readers.processes().filter((p) => VPN_PROCESS.test(p))),
  ];
  const adapters = readers
    .adapters()
    .filter((a) => VPN_ADAPTER.test(a.name) && a.up)
    .map((a) => a.name);
  return {
    clientRunning: processes.length > 0,
    connected: adapters.length > 0,
    processes,
    adapters,
  };
}

export type VpnVerdict =
  | { action: "ok" }
  | { action: "warn"; message: string }
  | { action: "refuse"; message: string };

/**
 * A connected VPN blocked the sandbox's network and logon before, so it is
 * refused when the sandbox needs the network; a client that is running but
 * disconnected only warns.
 */
export function vpnVerdict(report: VpnReport, networking: boolean): VpnVerdict {
  if (report.connected) {
    const what = `${report.processes.join(", ") || "VPN"} (adapter ${report.adapters.join(", ")})`;
    return networking
      ? {
          action: "refuse",
          message: `A VPN is connected on the host: ${what}. It stops the sandbox's network and can hang it. Disable the VPN, or use --network off.`,
        }
      : {
          action: "warn",
          message: `A VPN is connected on the host: ${what}. Networking is off, so continuing.`,
        };
  }
  if (report.clientRunning) {
    return {
      action: "warn",
      message: `VPN client running but no VPN adapter is up (${report.processes.join(", ")}); continuing.`,
    };
  }
  return { action: "ok" };
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Sandbox ids in `wsb start --raw` / `wsb list --raw` output. */
export function parseSandboxIds(output: string): string[] {
  return output.match(GUID) ?? [];
}

export interface SandboxResult {
  status: "done" | "timeout";
  exitCode?: number;
  stdout: string;
  stderr: string;
  waitedMs: number;
}

export interface PollDeps {
  exists(file: string): boolean;
  read(file: string): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Called each poll; lets the caller notice a sandbox that died */
  alive?(): boolean;
}

const realDeps: PollDeps = {
  exists: (f) => fs.existsSync(f),
  read: (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Poll the out share for the DONE marker until `timeoutMs`. */
export async function pollResult(
  outDir: string,
  opts: { timeoutMs: number; intervalMs?: number },
  deps: Partial<PollDeps> = {},
): Promise<SandboxResult> {
  const d = { ...realDeps, ...deps };
  const start = d.now();
  const interval = opts.intervalMs ?? 100;
  const file = (n: string) => path.join(outDir, n);
  for (;;) {
    if (d.exists(file(RESULT_FILES.done))) {
      const code = Number.parseInt(d.read(file(RESULT_FILES.exit)).trim(), 10);
      return {
        status: "done",
        exitCode: Number.isFinite(code) ? code : undefined,
        stdout: d.read(file(RESULT_FILES.stdout)),
        stderr: d.read(file(RESULT_FILES.stderr)),
        waitedMs: d.now() - start,
      };
    }
    if (d.now() - start >= opts.timeoutMs || d.alive?.() === false) {
      return {
        status: "timeout",
        stdout: d.read(file(RESULT_FILES.stdout)),
        stderr: d.read(file(RESULT_FILES.stderr)),
        waitedMs: d.now() - start,
      };
    }
    await d.sleep(interval);
  }
}
