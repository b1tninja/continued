/**
 * `continuous sandbox status`: whether the srt sandbox-runtime could run on
 * this machine, what is missing and the one-line fix for each, and the policy
 * Continuous WOULD pass. A status probe only: nothing is sandboxed, installed
 * or applied, and `srt` is never run (plans/ROADMAP.md W4a).
 */

import os from "node:os";
import path from "node:path";

import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import {
  compileSandboxConfig,
  describeSandboxPlan,
} from "core/util/sandboxPolicy.js";
import type { SandboxCompileResult } from "core/util/sandboxPolicyTypes.js";
import { effectivePolicyPreview } from "core/util/srtPolicyPreview.js";
import { detectSrt, type SrtStatus } from "core/util/srtStatus.js";
import { windowsSandboxStatus } from "core/util/windowsSandboxStatus.js";
import { wslStatus } from "core/util/wslStatus.js";

export interface SandboxCommandOptions {
  json?: boolean;
  modelHost?: string;
  workspace?: string;
}

function routesOnWindows(
  status: SrtStatus,
): Record<string, string> | undefined {
  if (status.host.kind !== "windows") return undefined;
  return {
    wsl2: wslStatus().state,
    windowsSandbox: windowsSandboxStatus().state,
  };
}

/**
 * The compiled plan (W8a) for this host and workspace: what the OS layer would
 * enforce, as configured. Never applied. A host kind srt does not support is a
 * refusal, not a guess.
 */
function compiledPlan(
  status: SrtStatus,
  workspace: string,
  modelHost: string | undefined,
): SandboxCompileResult {
  const kind = status.host.kind;
  if (kind !== "linux" && kind !== "wsl2" && kind !== "macos") {
    return {
      ok: false,
      reasons: [`srt does not run on this host kind (${kind})`],
      conflicts: [],
      warnings: [],
    };
  }
  return compileSandboxConfig({
    workspace,
    tempDir: path.join(os.tmpdir(), "continuous-sandbox-status"),
    homeDir: os.homedir(),
    platform: kind,
    levels: DEFAULT_POLICY_LEVELS,
    readPolicy: "workspace-only",
    egress: modelHost
      ? { network: "allowlist", modelHost }
      : { network: "none" },
  });
}

function formatText(
  status: SrtStatus,
  routes: Record<string, string> | undefined,
  preview: ReturnType<typeof effectivePolicyPreview>,
  plan: SandboxCompileResult,
): string[] {
  const lines = [
    `Sandbox runtime (srt): ${status.verdict}`,
    `Host: ${status.host.platform}/${status.host.arch} (${status.host.kind})${status.host.supported ? "" : ", not supported"}`,
  ];
  if (status.host.reason) lines.push(`  ${status.host.reason}`);
  if (routes) {
    lines.push(
      `  Routes on this host: WSL ${routes.wsl2}, Windows Sandbox ${routes.windowsSandbox}`,
    );
  }
  for (const c of status.checks) {
    const extra = [c.version, c.detail].filter(Boolean).join("; ");
    lines.push(`  ${c.id}: ${c.state}${extra ? ` (${extra})` : ""}`);
  }
  for (const [title, items] of [
    ["Missing", status.missing],
    ["Could not be confirmed", status.unknown],
  ] as const) {
    if (items.length === 0) continue;
    lines.push("", `${title}:`);
    for (const m of items) {
      lines.push(`  - ${m.item}: ${m.why}`, `    fix: ${m.fix}`);
    }
  }
  for (const w of status.warnings) lines.push("", `Warning: ${w}`);
  lines.push(
    "",
    "This is a status probe. Nothing is sandboxed yet, and no result here means contained.",
    "",
    preview.label,
    JSON.stringify(preview.config, null, 2),
  );
  for (const n of preview.notes.slice(1)) lines.push(`Note: ${n}`);
  lines.push("", "Not covered by srt:");
  for (const n of preview.notCovered) {
    lines.push(`  - ${n.item}: ${n.srtDefault}`);
  }
  lines.push("", `Files created later: ${preview.createdLater}`);
  lines.push("", ...describeSandboxPlan(plan));
  return lines;
}

export function sandboxCommand(
  action: string | undefined,
  options: SandboxCommandOptions = {},
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): number {
  if (action && action !== "status") {
    process.stderr.write(`Unknown action "${action}". Use: status\n`);
    return 1;
  }
  const status = detectSrt();
  const preview = effectivePolicyPreview(
    { modelHost: options.modelHost, hostKind: status.host.kind },
    options.workspace ?? process.cwd(),
  );
  const workspace = options.workspace ?? process.cwd();
  const plan = compiledPlan(status, workspace, options.modelHost);
  const routes = routesOnWindows(status);
  if (options.json) {
    out(
      JSON.stringify(
        { status, routes, policyPreview: preview, compiledPlan: plan },
        null,
        2,
      ),
    );
  } else {
    for (const line of formatText(status, routes, preview, plan)) out(line);
  }
  // A status that is not ready is an answer, not an error; scripts read --json
  return 0;
}
