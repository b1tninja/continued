import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture } from "../../llm/toolDialects/capture/fixture";
import { recordPolicyDecision } from "../../tools/permissions/audit/hook";
import { AuditTrail } from "../../tools/permissions/audit/trail";
import { testToolCall } from "../../tools/permissions/testToolCall";
import { scrubEnvironment } from "../scrubEnvironment";
import { buildWorkLog } from "../workLog";
import { canarySecrets } from "./canary";
import { secretValuesFromEnv } from "./envValues";

/**
 * X10: one canary suite. Each test puts the canaries somewhere a secret can
 * enter and reads what the surface emits. A canary must not appear verbatim.
 * The CLI surfaces (`/state`, `/agents`, `audit show`) are in
 * extensions/cli/src/commands/canary.test.ts, from the same helper.
 */
const canary = canarySecrets();

function expectClean(output: string): void {
  for (const c of canary.all) expect(output).not.toContain(c);
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function auditFilesText(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("canaries", () => {
  it("the helper's values are what the rules recognise", () => {
    expect(new Set(canary.all).size).toBe(canary.all.length);
    expect(canary.anthropicKey.startsWith("sk-ant-")).toBe(true);
  });

  it("tool call arguments, a pending request and a tool result never reach the audit file", () => {
    const trail = new AuditTrail({
      dir,
      enabled: true,
      now: () => new Date("2026-11-10T12:00:00.000Z"),
      syncImportant: false,
    });
    const command = `deploy ${canary.all.join(" ")}`;
    // the request that asks the person: its display value and reason
    recordPolicyDecision(
      trail,
      {
        session: "s1",
        callId: "c1",
        toolName: "run_terminal_command",
        parsedArgs: { command, nested: { token: canary.githubToken } },
      },
      "allowedWithPermission",
      {
        policy: "allowedWithPermission",
        displayValue: command,
        reason: `asks about ${canary.stripeKey}`,
      },
    );
    trail.outcome({
      callId: "c1",
      ran: true,
      output: `result ${canary.all.join(" ")}`,
      error: `failed: ${canary.npmToken}`,
    });
    const text = auditFilesText();
    expect(text.length).toBeGreaterThan(0);
    expectClean(text);
    expect(text).toContain("masked:");
  });

  it("an environment variable: removed by name, masked by value", () => {
    const env = {
      SERVICE_TOKEN: canary.githubToken,
      NOTE: `see ${canary.awsAccessKey}`,
      PATH: "/usr/bin",
    };
    const scrubbed = scrubEnvironment(env, { platform: "linux" });
    expect(Object.values(scrubbed.env).join(" ")).not.toContain(
      canary.githubToken,
    );
    // the value of a secret-named variable is a known value; NOTE is caught by shape
    expect(secretValuesFromEnv(env)).toContain(canary.githubToken);
  });

  it("the Permissions tester does not echo a credential in the call", () => {
    const r = testToolCall({
      tool: "runTerminalCommand",
      command: `curl https://example.test/${canary.anthropicKey} ${canary.awsAccessKey}`,
      sources: { user: { ask: ["runTerminalCommand(curl *)"] } },
      shell: "bash",
      cwd: process.cwd(),
    });
    expectClean(JSON.stringify(r));
  });

  it("the work log does not show a credential in a call, a remark or an error", () => {
    const log = buildWorkLog([
      {
        text: `I will use ${canary.stripeKey}`,
        calls: [],
      },
      {
        calls: [
          {
            tool: "Bash",
            args: { command: `push ${canary.githubToken}` },
            result: `${canary.npmToken}: not found`,
            error: true,
          },
        ],
      },
    ]);
    expectClean(JSON.stringify(log));
  });

  it("a captured reply is masked in every part of the fixture", () => {
    const text = `Sure, the key is ${canary.anthropicKey} and ${canary.awsAccessKey}.`;
    const fixture = buildFixture({ text, toolCalls: [], chunks: [text] }, {
      id: "canary",
      model: "m",
      transport: "openai",
      date: "2026-11-10",
      streamed: true,
      temperature: 0,
      tools: [],
      classified: { outcome: "refused", dialect: "none" },
    } as never);
    expect(fixture).toBeDefined();
    expectClean(JSON.stringify(fixture));
  });
});
