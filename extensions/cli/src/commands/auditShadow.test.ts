import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { canarySecrets } from "core/util/secretScan/canary.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auditCommand } from "./audit.js";

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-audit-shadow-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
    stderr.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(command = "git push --force") {
  const trail = new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-10T12:00:00Z"),
    syncImportant: false,
  });
  const decide = (callId: string, policy: "allow" | "deny", args: string) =>
    trail.decision({
      session: "s1",
      callId,
      tool: "Bash",
      args: JSON.stringify({ command: args }),
      policy,
      by: "rules",
    });
  const shadow = (callId: string, policy: "allow" | "ask" | "deny") =>
    trail.shadow({
      session: "s1",
      callId,
      tool: "Bash",
      real: { policy: callId === "1" ? "allow" : "deny", by: "rules" },
      shadow: { policy, reason: "Because." },
      reviewer: { model: "haiku-test", latencyMs: 400 },
      costUsd: 0.0012,
    });
  decide("1", "allow", command);
  shadow("1", "deny");
  decide("2", "deny", "ls");
  shadow("2", "deny");
}

describe("continuous audit shadow", () => {
  it("says how to turn it on when there is nothing", () => {
    expect(auditCommand("shadow", undefined, { dir })).toBe(0);
    expect(stdout.join("")).toContain("audit.shadowReviewer");
  });

  it("prints the matrix, the models, the cost and the disagreements", () => {
    seed();
    expect(auditCommand("shadow", undefined, { dir })).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("Shadow reviews: 2. Agreed: 1 (50.0%)");
    expect(text).toContain("haiku-test: 2 reviews");
    expect(text).toContain("$0.0024");
    expect(text).toContain("real allow by rules, reviewer deny");
    expect(text).toContain("git push --force");
    // the agreeing call is not listed as a disagreement
    expect(text).toContain("Disagreements (1 of 1");
  });

  it("prints json and never a secret value", () => {
    const key = canarySecrets().anthropicKey;
    seed(`curl -H "x-api-key: ${key}" https://a.example`);
    for (const json of [false, true]) {
      stdout = [];
      auditCommand("shadow", undefined, { dir, json });
      expect(stdout.join("")).not.toContain(key);
    }
    expect(JSON.parse(stdout.join("")).reviews).toBe(2);
  });

  it("filters by model and rejects a bad date", () => {
    seed();
    auditCommand("shadow", undefined, { dir, model: "other" });
    expect(stdout.join("")).toContain("No shadow reviews recorded");
    expect(auditCommand("shadow", undefined, { dir, since: "soon" })).toBe(2);
    expect(stderr.join("")).toContain("--since");
  });
});
