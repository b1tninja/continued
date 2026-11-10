#!/usr/bin/env node
/**
 * Print what the tool list costs a request, per mode, IDE and CLI, with and
 * without fixture MCP tool sets of 5, 20 and 60 tools (plans/tool-overhead.md).
 * Offline and deterministic: no model is called.
 *
 *   node scripts/measure-tool-overhead.mjs [--out report.md]
 *                                          [--gui-config <file>] [--cli-config <file>]
 *
 * It runs one test in gui and one in extensions/cli with TOOL_OVERHEAD_OUT
 * set, so the numbers come from the real selectActiveTools and
 * getAllAvailableTools, then joins the two reports. The --*-config flags pass
 * a vitest config through (for a checkout whose node_modules link elsewhere).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const tmp = mkdtempSync(join(tmpdir(), "tool-overhead-"));
const runs = [
  {
    cwd: join(root, "gui"),
    test: "src/redux/selectors/toolOverhead.test.ts",
    config: flag("--gui-config"),
    out: join(tmp, "ide.md"),
  },
  {
    cwd: join(root, "extensions", "cli"),
    test: "src/tools/toolOverhead.test.ts",
    config: flag("--cli-config"),
    out: join(tmp, "cli.md"),
  },
];

let failed = false;
const parts = [];
try {
  for (const r of runs) {
    const cmd = [
      "vitest",
      "run",
      ...(r.config ? ["-c", r.config] : []),
      r.test,
    ];
    const res = spawnSync("npx", cmd, {
      cwd: r.cwd,
      env: { ...process.env, TOOL_OVERHEAD_OUT: r.out },
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      failed = true;
      continue;
    }
    parts.push(readFileSync(r.out, "utf8"));
  }
  const report = parts.join("\n");
  const outFile = flag("--out");
  if (outFile) writeFileSync(outFile, report);
  console.log(report);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
