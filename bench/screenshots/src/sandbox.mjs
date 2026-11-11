// Takes the pictures inside a Windows Sandbox, as its logged-on user.
//
// Why not the repository's runner (extensions/cli/scripts/sandboxRun.ts)? That
// runs commands as System, which has no desktop session, and Microsoft Edge
// exits at once under System. A logged-on user needs `wsb connect`, which opens
// the Windows Sandbox client window on this PC (see README). Everything else
// follows the runner's facts: mapped folders are snapshots taken at start, the
// network is off, the host's Node is mapped read-only, results come back
// through a writable folder, and the sandbox is always stopped.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCREENSHOTS_DIR } from "./build.mjs";

const TIMEOUT_MS = 240_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const xml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The one-line .wsb text `wsb start --config` takes: no double quote, no newline. */
export function sandboxConfig({ payload, out, nodeDir }) {
  const folder = (host, sandbox, readOnly) =>
    `<MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${xml(sandbox)}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
  return (
    "<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><MappedFolders>" +
    folder(payload, "C:\\payload", true) +
    folder(nodeDir, "C:\\node", true) +
    folder(out, "C:\\out", false) +
    "</MappedFolders></Configuration>"
  );
}

/** The batch file the sandbox user runs: the entry script, its log, then a marker. */
export function runCmd() {
  return [
    "@echo off",
    "C:\\node\\node.exe C:\\payload\\sandbox-entry.mjs > C:\\out\\run.log 2>&1",
    ">C:\\out\\run.exit echo %errorlevel%",
    ">C:\\out\\DONE echo done",
    "",
  ].join("\r\n");
}

export function findWsb(env = process.env) {
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter),
    path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Microsoft",
      "WindowsApps",
    ),
  ];
  const found = dirs
    .filter(Boolean)
    .map((d) => path.join(d, "wsb.exe"))
    .find((p) => {
      // wsb.exe is an app execution alias (a reparse point): existsSync says no
      try {
        fs.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    });
  if (!found) {
    throw new Error(
      "wsb.exe not found (Windows 11 Pro 24H2 or newer with Windows Sandbox enabled).",
    );
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

export async function shootInSandbox({ dist, out, jobs, playwrightDir }) {
  if (process.platform !== "win32") {
    throw new Error("--sandbox needs Windows (Windows Sandbox).");
  }
  const wsb = findWsb();
  const run = (args, timeout = 60_000) =>
    execFileSync(wsb, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const running = run(["list", "--raw"]).match(new RegExp(UUID, "gi")) ?? [];
  if (running.length) {
    throw new Error(
      `A Windows Sandbox is already running (${running.join(", ")}); stop it with: wsb stop --id <id>`,
    );
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shot-sbx-"));
  const payload = path.join(work, "payload");
  const outShare = path.join(work, "out");
  fs.mkdirSync(payload);
  fs.mkdirSync(outShare);
  copyDir(dist, path.join(payload, "dist"));
  copyDir(playwrightDir, path.join(payload, "vendor", "playwright-core"));
  copyDir(path.join(SCREENSHOTS_DIR, "src"), path.join(payload, "src"));
  fs.copyFileSync(
    path.join(SCREENSHOTS_DIR, "sandbox-entry.mjs"),
    path.join(payload, "sandbox-entry.mjs"),
  );
  fs.writeFileSync(path.join(payload, "job.json"), JSON.stringify({ jobs }));
  fs.writeFileSync(path.join(payload, "run.cmd"), runCmd());

  const t0 = Date.now();
  const log = (m) =>
    console.error(`[sandbox ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  let id;
  let client;
  try {
    const started = run([
      "start",
      "--raw",
      "--config",
      sandboxConfig({
        payload,
        out: outShare,
        nodeDir: path.dirname(process.execPath),
      }),
    ]);
    id = UUID.exec(started)?.[0];
    if (!id) throw new Error(`wsb start returned no id: ${started}`);
    log(`started ${id}`);
    // opens the Windows Sandbox client window and logs the user in
    client = spawn(wsb, ["connect", "--id", id], { stdio: "ignore" });
    client.on("error", () => {});
    let ran = false;
    while (Date.now() - t0 < TIMEOUT_MS && !ran) {
      await sleep(2000);
      try {
        run(
          [
            "exec",
            "--id",
            id,
            "-r",
            "ExistingLogin",
            "-c",
            "cmd /c C:\\payload\\run.cmd",
          ],
          TIMEOUT_MS,
        );
        ran = true;
      } catch (e) {
        // "A specified logon session does not exist" until the logon finishes
        if (!/logon session/i.test(String(e.stderr ?? e.stdout ?? e.message))) {
          throw e;
        }
      }
    }
    if (!ran) throw new Error("the sandbox user never logged on (timeout)");
    log("run finished");
    for (
      let i = 0;
      i < 50 && !fs.existsSync(path.join(outShare, "DONE"));
      i++
    ) {
      await sleep(200);
    }
    const resultFile = path.join(outShare, "entry-result.json");
    const result = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
      : { ok: false, error: "no entry-result.json" };
    if (!result.ok) {
      const logFile = path.join(outShare, "run.log");
      throw new Error(
        `sandbox run failed: ${result.error}\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2000) : ""}`,
      );
    }
    fs.mkdirSync(out, { recursive: true });
    copyDir(path.join(outShare, "shots"), out);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, "manifest.json"), "utf8"),
    );
    manifest.sandbox = { id, totalMs: Date.now() - t0 };
    fs.writeFileSync(
      path.join(out, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return manifest;
  } finally {
    try {
      client?.kill();
    } catch {
      // gone already
    }
    if (id) {
      try {
        run(["stop", "--id", id]);
      } catch (e) {
        console.error(`wsb stop failed: ${String(e.message).split("\n")[0]}`);
      }
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}
