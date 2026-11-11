import { execFileSync } from "child_process";

import { describe, expect, it } from "vitest";

import { LOOP_CHECK_KILL_GRACE_MS, runCheckCommand } from "./loopChecks.js";

// No mocks: these start the real shell the executor resolves (PowerShell on
// Windows, the login shell elsewhere) and real child processes.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

/** The pids of every node process whose command line holds `marker`. */
function nodePidsWith(marker: string): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`,
        ],
        { encoding: "utf8" },
      );
      return out.split(/\s+/).filter(Boolean).map(Number);
    }
    const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

describe("loop checks report the real exit code (unmocked)", () => {
  it("a check that exits 3 reports 3", async () => {
    const run = await runCheckCommand('node -e "process.exit(3)"');
    expect(run.exitCode).toBe(3);
  });

  it("a check that succeeds reports 0 and its output", async () => {
    const run = await runCheckCommand("node -e \"console.log('fine')\"");
    expect(run).toEqual({ exitCode: 0, output: "fine" });
  });

  it("a failing cmdlet or builtin reports 1", async () => {
    const command =
      process.platform === "win32"
        ? "Get-Item D:\definitely\not\here"
        : "cat /definitely/not/here";
    const run = await runCheckCommand(command);
    expect(run.exitCode).toBe(1);
  });

  it.runIf(process.platform === "win32")(
    "a stale native code does not leak past a later success or failure",
    async () => {
      expect(
        (await runCheckCommand('node -e "process.exit(3)"; Write-Output hi'))
          .exitCode,
      ).toBe(0);
      expect(
        (
          await runCheckCommand(
            'node -e "process.exit(3)"; Get-Item D:\definitely\not\here',
          )
        ).exitCode,
      ).toBe(1);
    },
  );
});

describe("loop check timeouts (unmocked)", () => {
  it("stop the command and the processes it started", async () => {
    const marker = `loopcheck_${process.pid}_${Date.now()}`;
    const started = Date.now();
    const run = await runCheckCommand(
      `node -e "setInterval(()=>{},1e3)" ${marker}`,
      process.cwd(),
      2000,
    );
    expect(run.exitCode).toBeNull();
    expect(run.output).toContain("stopped after 2 seconds");
    expect(Date.now() - started).toBeLessThan(15000);
    // The tree is gone: no node process still carries the marker
    const gone = await until(
      () => nodePidsWith(marker).every((p) => !alive(p)),
      8000,
    );
    expect(gone).toBe(true);
  }, 30000);

  it.runIf(process.platform !== "win32")(
    "SIGKILL follows after the grace when SIGTERM is ignored",
    async () => {
      const marker = `loopcheck_ign_${process.pid}_${Date.now()}`;
      const started = Date.now();
      // The shell stays up as the group's leader, and the child ignores SIGTERM
      const run = await runCheckCommand(
        `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)" ${marker} & wait`,
        process.cwd(),
        1000,
      );
      expect(run.exitCode).toBeNull();
      const gone = await until(
        () => nodePidsWith(marker).every((p) => !alive(p)),
        LOOP_CHECK_KILL_GRACE_MS + 6000,
      );
      expect(gone).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    },
    30000,
  );
});
