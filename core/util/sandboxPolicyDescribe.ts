import type { SandboxCompileResult } from "./sandboxPolicyTypes";

const SHOWN = 6;

function list(title: string, entries: string[], indent = "  "): string[] {
  if (entries.length === 0) return [`${indent}${title}: none`];
  const head = entries.slice(0, SHOWN).map((e) => `${indent}  - ${e}`);
  const more =
    entries.length > SHOWN
      ? [`${indent}  - and ${entries.length - SHOWN} more`]
      : [];
  return [`${indent}${title} (${entries.length}):`, ...head, ...more];
}

/**
 * The plan as lines for the Permissions page and `continuous sandbox status`.
 * Says "confined as configured", never "contained".
 */
export function describeSandboxPlan(plan: SandboxCompileResult): string[] {
  if (!plan.ok) {
    return [
      "Sandbox plan: REFUSED (fail closed). Run without the sandbox and ask, or do not run.",
      ...plan.reasons.map((r) => `  - ${r}`),
      ...plan.warnings.map((w) => `  Warning: ${w}`),
    ];
  }
  const { filesystem: fs, network: net } = plan.config;
  const lines = [
    `Sandbox plan: ${plan.label}`,
    `  Platform ${plan.platform}, reads ${plan.readPolicy}, workspace ${plan.workspace}`,
    ...list("Writable", fs.allowWrite),
    ...list("Write-protected", fs.denyWrite),
    ...list("Hidden from reads", fs.denyRead),
    ...list("Readable again", fs.allowRead),
    ...list("Network allowed", net.allowedDomains),
    ...list("Network denied", net.deniedDomains),
  ];
  if (plan.weakened.length > 0) {
    lines.push(`  WEAKENED, not contained: ${plan.weakened.join(", ")}`);
  }
  lines.push("", "  Enforced by the OS layer, as configured:");
  const bySource = new Map<string, number>();
  for (const e of plan.enforced) {
    const key = `${e.effect} from ${e.source} (${e.from})`;
    bySource.set(key, (bySource.get(key) ?? 0) + e.entries.length);
  }
  for (const [key, n] of bySource) lines.push(`    - ${key}: ${n} entries`);
  lines.push("", "  Not enforced:");
  for (const n of plan.notEnforced) lines.push(`    - ${n.item}: ${n.why}`);
  if (plan.policyOnly.length > 0) {
    lines.push("", "  Decided by the permission engine only:");
    for (const p of plan.policyOnly) lines.push(`    - ${p}`);
  }
  if (plan.precreate.length > 0) {
    lines.push("", ...list("Placeholders to create if absent", plan.precreate));
  }
  for (const w of plan.warnings) lines.push(`  Warning: ${w}`);
  lines.push(
    "",
    "  Nothing is applied by this plan. Contained only after our probes say so.",
  );
  return lines;
}
