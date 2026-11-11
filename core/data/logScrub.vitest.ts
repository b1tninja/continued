import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { canary } from "../util/secretScan/scrubForDisk.vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devdata-scrub-"));
const file = path.join(dir, "toolUsage.jsonl");

vi.mock("@continuedev/fetch");
vi.mock("../util/paths.js", async (orig) => ({
  ...(await orig<typeof import("../util/paths.js")>()),
  getDevDataFilePath: () => file,
}));

import { DataLogger } from "./log";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("dev data scrub-on-write (X15)", () => {
  it("a canary secret in a tool call never lands in the file", async () => {
    const c = canary();
    await DataLogger.getInstance().logLocalData({
      name: "toolUsage",
      data: {
        toolCallId: "1",
        functionName: "run_terminal_command",
        functionParams: { command: `curl -H "x-api-key: ${c.anthropic}"` },
        toolCallArgs: JSON.stringify({ command: `export K=${c.github}` }),
        accepted: true,
        succeeded: true,
        output: [{ content: `AWS_ACCESS_KEY_ID=${c.aws}` }],
      },
    } as never);
    const text = fs.readFileSync(file, "utf8");
    expect(text.length).toBeGreaterThan(0);
    for (const v of Object.values(c)) expect(text).not.toContain(v);
    expect(text).toContain("REDACTED");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });
});
