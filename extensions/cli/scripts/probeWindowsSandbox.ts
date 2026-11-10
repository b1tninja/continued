/**
 * Times one Windows Sandbox cycle: start, share, exec, poll, stop
 * (plans/isolation.md, W9). Windows only.
 *
 *   npx tsx scripts/probeWindowsSandbox.ts            # detect only, starts nothing
 *   npx tsx scripts/probeWindowsSandbox.ts --run      # really starts a sandbox
 *   npx tsx scripts/probeWindowsSandbox.ts --run --json
 *
 * `--run` is required because it starts a Windows Sandbox VM (several hundred
 * MB of memory, a few seconds to tens of seconds). It refuses if a sandbox is
 * already running, starts one with networking disabled, shares a scratch
 * folder in the OS temp directory writable, runs `cmd /c echo ok > ok.txt`
 * as System (the one mode that works without a logon), polls the share for the
 * file, and stops the sandbox. `wsb exec` returns no process output, which is
 * why the result travels through the share. The sandbox is stopped on any
 * failure and the scratch folder is removed.
 *
 * Installs nothing and changes no setting.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  windowsSandboxStatus,
  windowsSandboxUnavailableMessage,
} from "core/util/windowsSandboxStatus.js";

interface Step {
  step: string;
  ms: number;
  ok: boolean;
  detail?: string;
}

const POLL_MS = 100;
const POLL_TIMEOUT_MS = 120_000;
const SANDBOX_DIR = "C:\\Scratch";

function wsb(wsbPath: string, args: string[]): string {
  return execFileSync(wsbPath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The id of a sandbox from `wsb start --raw` or `wsb list --raw` output. */
export function parseSandboxId(output: string): string | undefined {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(
    output,
  )?.[0];
}

function listRunning(wsbPath: string): string[] {
  const out = wsb(wsbPath, ["list", "--raw"]);
  return (
    out.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ) ?? []
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function markdown(
  report: Record<string, unknown>,
  steps: Step[],
  total: number,
): string {
  const rows = steps
    .map(
      (s) =>
        `| ${s.step} | ${s.ms} | ${s.ok ? "yes" : "no"} | ${s.detail ?? ""} |`,
    )
    .join("\n");
  return [
    "# Windows Sandbox timing probe",
    "",
    `Edition ${report.edition}, build ${report.build}, ${report.when}.`,
    "",
    "| step | ms | ok | detail |",
    "| --- | ---: | --- | --- |",
    rows,
    `| total | ${total} | | |`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  if (process.platform !== "win32") {
    console.error("Windows Sandbox is only available on Windows. Not run.");
    process.exit(1);
  }
  const status = windowsSandboxStatus();
  if (status.state !== "ready") {
    console.log(JSON.stringify(status, null, 2));
    console.error(windowsSandboxUnavailableMessage(status));
    process.exit(1);
  }
  if (!args.includes("--run")) {
    console.log(JSON.stringify(status, null, 2));
    console.error(
      "Detection only. Pass --run to start a Windows Sandbox and time a cycle.",
    );
    return;
  }

  const wsbPath = status.wsbPath;
  const running = listRunning(wsbPath);
  if (running.length > 0) {
    console.error(
      `A Windows Sandbox is already running (${running.join(", ")}). Stop it first; not run.`,
    );
    process.exit(1);
  }

  const steps: Step[] = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-probe-"));
  let id: string | undefined;
  const t0 = Date.now();

  async function timed<T>(step: string, fn: () => T | Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      const value = await fn();
      steps.push({ step, ms: Date.now() - t, ok: true });
      return value;
    } catch (e) {
      steps.push({
        step,
        ms: Date.now() - t,
        ok: false,
        detail: String((e as Error).message)
          .split("\n")[0]
          .slice(0, 200),
      });
      throw e;
    }
  }

  try {
    id = await timed("start (networking disabled)", () => {
      const out = wsb(wsbPath, [
        "start",
        "--raw",
        "-c",
        "<Configuration><Networking>Disable</Networking></Configuration>",
      ]);
      const found = parseSandboxId(out);
      if (!found) throw new Error(`no id in: ${out.slice(0, 200)}`);
      return found;
    });
    await timed("share -w scratch", () =>
      wsb(wsbPath, [
        "share",
        "--id",
        id!,
        "-f",
        scratch,
        "-s",
        SANDBOX_DIR,
        "-w",
      ]),
    );
    await timed("exec -r System", () =>
      wsb(wsbPath, [
        "exec",
        "--id",
        id!,
        "-r",
        "System",
        "-c",
        `cmd.exe /c echo ok> ${SANDBOX_DIR}\\ok.txt`,
      ]),
    );
    await timed("poll share for ok.txt", async () => {
      const file = path.join(scratch, "ok.txt");
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error("ok.txt never appeared");
        await sleep(POLL_MS);
      }
    });
  } catch {
    // The failing step is already recorded
  } finally {
    if (id) {
      const stopId = id;
      await timed("stop", () => wsb(wsbPath, ["stop", "--id", stopId])).catch(
        () => undefined,
      );
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const total = Date.now() - t0;
  const report = {
    edition: status.edition,
    build: status.build,
    when: new Date().toISOString(),
  };
  console.log(
    json
      ? JSON.stringify({ ...report, steps, totalMs: total }, null, 2)
      : markdown(report, steps, total),
  );
  if (steps.some((s) => !s.ok)) process.exit(1);
}

if (process.argv[1] && /probeWindowsSandbox/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
