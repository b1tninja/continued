/* eslint-disable max-statements, complexity, no-negated-condition -- a linear command-line driver */
/**
 * Runs one command inside a fresh Windows Sandbox and returns its output
 * (plans/windows-sandbox-runner.md). Windows only.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/sandboxRun.ts \
 *     --payload <dir> --cmd "node run.mjs args" \
 *     [--network on|off] [--timeout 300] [--out <dir>] [--keep] [--ignore-vpn] \
 *     [--map <hostDir>=<C:\name>]...
 *
 * The payload is copied with plain file operations (no .git, node_modules or
 * big files) and mapped read-only at C:\payload; the host's Node install is
 * mapped read-only at C:\node and put on PATH; an empty out folder is mapped
 * writable at C:\out. The command runs as System through `wsb exec` (the only
 * mode that works without a logged-on user) wrapped so it writes stdout.txt,
 * stderr.txt, exit.txt and a DONE marker into C:\out, which this script polls.
 * The sandbox is always stopped: on success, failure, timeout and Ctrl-C.
 * Refuses when a sandbox is already running or a connected VPN would stop the
 * sandbox's network. Each `--map <hostDir>=<C:\name>` adds one more READ-ONLY
 * mapped folder (a browser cache, say). No API keys are passed in.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRunnerCmd,
  buildSandboxConfig,
  copyPayload,
  detectVpn,
  parseMapArg,
  parseSandboxIds,
  pollResult,
  vpnVerdict,
  type MappedFolder,
  type VpnReaders,
} from "core/util/windowsSandboxRun.js";
import {
  windowsSandboxStatus,
  windowsSandboxUnavailableMessage,
} from "core/util/windowsSandboxStatus.js";

const SANDBOX_PAYLOAD = "C:\\payload";
const SANDBOX_OUT = "C:\\out";
const SANDBOX_NODE = "C:\\node";

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
/** Every value of a repeatable option: `--map a=b --map c=d`. */
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] !== undefined) {
      out.push(process.argv[i + 1]);
    }
  });
  return out;
}

function psLines(script: string): string[] {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const vpnReaders: VpnReaders = {
  processes: () => psLines("Get-Process | ForEach-Object { $_.ProcessName }"),
  adapters: () =>
    psLines(
      "Get-NetAdapter | ForEach-Object { $_.Name + '|' + $_.Status }",
    ).map((l) => {
      const [name, status] = l.split("|");
      return { name, up: status === "Up" };
    }),
};

async function main(): Promise<void> {
  if (process.platform !== "win32") fail("Windows Sandbox is Windows only.");
  const payload = arg("payload");
  const cmd = arg("cmd");
  if (!payload || !cmd) {
    fail(
      'Usage: sandboxRun.ts --payload <dir> --cmd "node run.mjs args" [--network on|off] [--timeout 300] [--out <dir>] [--keep] [--ignore-vpn] [--map <hostDir>=<C:\\name>]...',
    );
  }
  const networkArg = arg("network") ?? "off";
  if (networkArg !== "on" && networkArg !== "off") {
    fail("--network takes on or off");
  }
  const networking = networkArg === "on";
  const timeoutS = Number(arg("timeout") ?? "300");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) fail("Bad --timeout");
  if (!fs.statSync(payload, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Payload is not a directory: ${payload}`);
  }

  let extraFolders: MappedFolder[] = [];
  try {
    extraFolders = args("map").map(parseMapArg);
  } catch (e) {
    fail((e as Error).message);
  }

  const status = windowsSandboxStatus();
  if (status.state !== "ready") {
    fail(
      windowsSandboxUnavailableMessage(status) ??
        "Windows Sandbox is unavailable.",
    );
  }
  const wsbPath = status.wsbPath;
  const wsb = (args: string[]) =>
    execFileSync(wsbPath, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const running = parseSandboxIds(wsb(["list", "--raw"]));
  if (running.length > 0) {
    fail(
      `A Windows Sandbox is already running (${running.join(", ")}); only one can run at a time. Stop it with: wsb stop --id <id>`,
    );
  }
  if (!flag("ignore-vpn")) {
    const verdict = vpnVerdict(detectVpn(vpnReaders), networking);
    if (verdict.action === "refuse") fail(verdict.message);
    if (verdict.action === "warn") console.error(`warning: ${verdict.message}`);
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();
  let mark = t0;
  const lap = (name: string) => {
    const now = Date.now();
    timings[name] = now - mark;
    mark = now;
  };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sbxrun-"));
  const payloadCopy = path.join(work, "payload");
  const outDir = path.resolve(arg("out") ?? path.join(work, "out"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of ["exit.txt", "stdout.txt", "stderr.txt", "DONE"]) {
    fs.rmSync(path.join(outDir, f), { force: true });
  }
  const report = copyPayload(path.resolve(payload), payloadCopy);
  console.error(
    `payload: ${report.copied.length} files, ${report.totalBytes} bytes copied; ${report.skipped.length} skipped${report.skipped.length ? ` (${report.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ")})` : ""}`,
  );
  fs.writeFileSync(
    path.join(payloadCopy, "__run.cmd"),
    buildRunnerCmd({
      command: cmd,
      payloadDir: SANDBOX_PAYLOAD,
      outDir: SANDBOX_OUT,
      nodeDir: SANDBOX_NODE,
    }),
  );
  lap("prepare");

  let id: string | undefined;
  let execProc: ChildProcess | undefined;
  const stop = () => {
    if (!id) return;
    const stopId = id;
    id = undefined;
    try {
      execProc?.kill();
    } catch {
      // already gone
    }
    try {
      wsb(["stop", "--id", stopId]);
    } catch (e) {
      console.error(`wsb stop failed: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  process.on("SIGINT", () => {
    console.error("Interrupted; stopping the sandbox.");
    stop();
    process.exit(130);
  });

  let exitCode = 1;
  try {
    const config = buildSandboxConfig({
      networking,
      folders: [
        { host: payloadCopy, sandbox: SANDBOX_PAYLOAD, readOnly: true },
        {
          host: path.dirname(process.execPath),
          sandbox: SANDBOX_NODE,
          readOnly: true,
        },
        { host: outDir, sandbox: SANDBOX_OUT, readOnly: false },
        ...extraFolders,
      ],
    });
    const started = parseSandboxIds(
      wsb(["start", "--raw", "--config", config]),
    );
    id = started[0];
    if (!id) throw new Error("wsb start returned no sandbox id");
    lap("start");

    // `wsb exec` returns only when the command has finished, so it is not
    // awaited: the result file is what is polled, and a hung command is
    // killed by stopping the sandbox.
    execProc = spawn(
      wsbPath,
      [
        "exec",
        "--id",
        id,
        "-r",
        "System",
        "-c",
        `cmd.exe /c ${SANDBOX_PAYLOAD}\\__run.cmd`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    execProc.on("error", () => undefined);
    const result = await pollResult(outDir, { timeoutMs: timeoutS * 1000 });
    lap(result.status === "done" ? "run" : "run (timed out)");

    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === "timeout") {
      console.error(`TIMEOUT after ${timeoutS}s; killing the sandbox.`);
      exitCode = 124;
    } else {
      exitCode = result.exitCode ?? 1;
      console.error(`exit code in sandbox: ${result.exitCode}`);
    }
  } catch (e) {
    console.error(`sandboxRun failed: ${(e as Error).message}`);
  } finally {
    stop();
    lap("stop");
    const left = parseSandboxIds(wsb(["list", "--raw"]));
    console.error(
      `timings (ms): ${JSON.stringify({ ...timings, total: Date.now() - t0 })}; sandboxes left: ${left.length}`,
    );
    if (left.length > 0) exitCode = exitCode || 1;
    if (!flag("keep")) {
      fs.rmSync(work, { recursive: true, force: true });
    } else {
      console.error(`kept: ${work} (out: ${outDir})`);
    }
  }
  // A sandbox exit code can be an NTSTATUS (negative or above 255): keep it
  // non-zero when truncating to what a process can return
  process.exit(
    exitCode === 0 ? 0 : exitCode > 0 && exitCode < 256 ? exitCode : 1,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
