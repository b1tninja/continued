import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRunnerCmd,
  buildSandboxConfig,
  copyPayload,
  detectVpn,
  escapeXml,
  parseSandboxIds,
  pollResult,
  vpnVerdict,
} from "./windowsSandboxRun";

describe("buildSandboxConfig", () => {
  it("is one line with no double quote and escapes paths", () => {
    const xml = buildSandboxConfig({
      networking: false,
      folders: [
        { host: 'C:\\a&b\\"x"', sandbox: "C:\\p<1>", readOnly: true },
        { host: "C:\\out", sandbox: "C:\\out", readOnly: false },
      ],
    });
    expect(xml).not.toMatch(/["\r\n]/);
    expect(xml).toContain("<Networking>Disable</Networking>");
    expect(xml).toContain("C:\\a&amp;b\\&quot;x&quot;");
    expect(xml).toContain("C:\\p&lt;1&gt;");
    expect(xml).toContain("<ReadOnly>true</ReadOnly>");
    expect(xml).toContain("<ReadOnly>false</ReadOnly>");
  });
  it("enables networking and refuses control characters", () => {
    expect(buildSandboxConfig({ networking: true, folders: [] })).toContain(
      "<Networking>Default</Networking>",
    );
    expect(() =>
      buildSandboxConfig({
        networking: true,
        folders: [{ host: "C:\\a\nb", sandbox: "C:\\x", readOnly: true }],
      }),
    ).toThrow(/Control character/);
  });
  it("escapeXml", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("buildRunnerCmd", () => {
  it("writes DONE last and sets PATH", () => {
    const cmd = buildRunnerCmd({
      command: "node run.mjs a",
      payloadDir: "C:\\payload",
      outDir: "C:\\out\\",
      nodeDir: "C:\\node",
    });
    const lines = cmd.split("\r\n").filter(Boolean);
    expect(lines).toContain('set "PATH=C:\\node;%PATH%"');
    expect(lines).toContain('cd /d "C:\\payload"');
    expect(lines).toContain("node run.mjs a");
    expect(lines.at(-1)).toBe('>"C:\\out\\DONE" echo done');
    expect(lines.at(-2)).toBe('>"C:\\out\\exit.txt" echo %errorlevel%');
  });
});

describe("copyPayload", () => {
  it("skips .git, node_modules and big files and reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "payload-test-"));
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    try {
      fs.mkdirSync(path.join(src, ".git"), { recursive: true });
      fs.mkdirSync(path.join(src, "node_modules", "x"), { recursive: true });
      fs.mkdirSync(path.join(src, "sub"), { recursive: true });
      fs.writeFileSync(path.join(src, ".git", "HEAD"), "x");
      fs.writeFileSync(path.join(src, "node_modules", "x", "i.js"), "x");
      fs.writeFileSync(path.join(src, "run.mjs"), "abc");
      fs.writeFileSync(path.join(src, "sub", "a.txt"), "de");
      fs.writeFileSync(path.join(src, "big.bin"), "x".repeat(100));
      const r = copyPayload(src, dest, { maxFileBytes: 50 });
      expect(r.copied.map((c) => c.path).sort()).toEqual([
        "run.mjs",
        "sub/a.txt",
      ]);
      expect(r.totalBytes).toBe(5);
      expect(r.skipped.map((s) => s.path).sort()).toEqual([
        ".git",
        "big.bin",
        "node_modules",
      ]);
      expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
      expect(fs.readFileSync(path.join(dest, "sub", "a.txt"), "utf8")).toBe(
        "de",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("vpn detection", () => {
  const procs = ["NordVPN.exe", "node.exe"];
  it("distinguishes running from connected", () => {
    const idle = detectVpn({
      processes: () => procs,
      adapters: () => [{ name: "NordLynx", up: false }],
    });
    expect(idle).toMatchObject({ clientRunning: true, connected: false });
    expect(vpnVerdict(idle, true).action).toBe("warn");
    const up = detectVpn({
      processes: () => procs,
      adapters: () => [{ name: "NordLynx", up: true }],
    });
    expect(vpnVerdict(up, true).action).toBe("refuse");
    expect(vpnVerdict(up, false).action).toBe("warn");
    expect(vpnVerdict(up, true)).toMatchObject({
      message: expect.stringContaining("--network off"),
    });
  });
  it("is ok without a VPN", () => {
    const none = detectVpn({
      processes: () => ["node.exe"],
      adapters: () => [{ name: "Ethernet", up: true }],
    });
    expect(vpnVerdict(none, true)).toEqual({ action: "ok" });
  });
});

describe("parseSandboxIds", () => {
  it("finds guids", () => {
    const id = "0a1b2c3d-1111-2222-3333-444455556666";
    expect(parseSandboxIds(`id: ${id}\n`)).toEqual([id]);
    expect(parseSandboxIds("")).toEqual([]);
  });
});

describe("pollResult", () => {
  const mk = (files: Record<string, string>, doneAt: number) => {
    let t = 0;
    return {
      exists: (f: string) => t >= doneAt && path.basename(f) === "DONE",
      read: (f: string) => files[path.basename(f)] ?? "",
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  it("returns the files once DONE appears", async () => {
    const r = await pollResult(
      "C:\\out",
      { timeoutMs: 1000, intervalMs: 100 },
      mk({ "exit.txt": "3 \r\n", "stdout.txt": "hi", "stderr.txt": "e" }, 300),
    );
    expect(r).toMatchObject({
      status: "done",
      exitCode: 3,
      stdout: "hi",
      stderr: "e",
      waitedMs: 300,
    });
  });
  it("times out", async () => {
    const r = await pollResult(
      "C:\\out",
      { timeoutMs: 500, intervalMs: 100 },
      mk({}, 10_000),
    );
    expect(r.status).toBe("timeout");
    expect(r.exitCode).toBeUndefined();
  });
  it("stops early when the sandbox is gone", async () => {
    const r = await pollResult(
      "C:\\out",
      { timeoutMs: 5000 },
      { ...mk({}, 10_000), alive: () => false },
    );
    expect(r.status).toBe("timeout");
    expect(r.waitedMs).toBe(0);
  });
});
