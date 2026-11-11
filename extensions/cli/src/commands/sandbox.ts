/**
 * `continuous sandbox status`: whether the srt sandbox-runtime could run on
 * this machine, what is missing and the one-line fix for each, and the policy
 * Continuous WOULD pass. A status probe only: nothing is sandboxed, installed
 * or applied, and `srt` is never run (plans/ROADMAP.md W4a).
 */

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

function formatText(
  status: SrtStatus,
  routes: Record<string, string> | undefined,
  preview: ReturnType<typeof effectivePolicyPreview>,
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
  const routes = routesOnWindows(status);
  if (options.json) {
    out(JSON.stringify({ status, routes, policyPreview: preview }, null, 2));
  } else {
    for (const line of formatText(status, routes, preview)) out(line);
  }
  // A status that is not ready is an answer, not an error; scripts read --json
  return 0;
}
