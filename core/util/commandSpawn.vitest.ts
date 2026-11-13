import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getCommandExecutor } from "./commandExecutor";
import { COMMAND_STDIO } from "./commandSpawn";

/** Runs to the end and reports what the command printed and how long it took. */
function finish(
  child: ChildProcess,
): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, out, err, ms: Date.now() - started }),
    );
  });
}

describe("a command cannot wait for an answer", () => {
  it("gives a command no open standard input", () => {
    expect(COMMAND_STDIO).toEqual(["ignore", "pipe", "pipe"]);
  });

  // Real shells: before, each of these waited until the tool's timeout
  it.runIf(process.platform === "win32")(
    "Read-Host fails at once in Windows PowerShell",
    async () => {
      const child = getCommandExecutor({ terminalShell: "default" }).spawn(
        "Read-Host 'name'",
        { windowsHide: true },
      );
      expect(child.stdin).toBeNull();
      const result = await finish(child);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/NonInteractive/);
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "a cmdlet missing a mandatory parameter fails instead of asking for it",
    async () => {
      // Get-Content with no -Path asks "Path[0]:" in an interactive session
      const result = await finish(
        getCommandExecutor({ terminalShell: "default" }).spawn("Get-Content", {
          windowsHide: true,
        }),
      );
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/Path/);
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "read in sh sees end of file at once",
    async () => {
      const child = getCommandExecutor({
        terminalShell: "default",
        env: { SHELL: "/bin/sh" },
      }).spawn("read x; echo got=$x");
      expect(child.stdin).toBeNull();
      const result = await finish(child);
      expect(result.out).toContain("got=");
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );
});
