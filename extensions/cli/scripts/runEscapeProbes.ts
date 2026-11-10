/**
 * Runs the common escape probes through one command executor and prints what
 * they found (plans/jail-network.md, W7). Starts nothing that persists: the
 * workspace is a fresh temporary folder, the canaries are fake files in
 * another temporary folder, and both are removed at the end. Run it on a
 * machine you are willing to run a few probe commands on; against `local` the
 * probes find the host open by design.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/runEscapeProbes.ts --backend wsl [--distro NAME]
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/runEscapeProbes.ts --backend container [--runtime docker|podman] [--image ubuntu:24.04]
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/runEscapeProbes.ts --backend local
 *
 * Options: `--only id,id` to run some probes, `--json` for machine output,
 * `--no-listener` to skip the canary listener (the network probes that need it
 * are then skipped), `--timeout-ms N` per probe.
 *
 * Two probes contact the outside world if the jail lets them: `network.public-tcp`
 * opens a TCP connection to 1.1.1.1:443 and `network.dns` resolves example.com.
 * Nothing is sent. Pass `--offline` to skip both.
 *
 * Reading the output: `pass` means the attempt did not get through, `fail`
 * that it did, `skip` that it could not be tried here, `error` that the probe
 * could not run. A property is `verified` only when no probe failed and a
 * strong probe passed; weak passes (marked `weak`) never verify on their own.
 * These are probes, not proofs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCommandExecutor } from "core/util/commandExecutor.js";
import { createCanaries, runProbes } from "core/util/escapeProbeRunner.js";
import {
  COMMON_PROBES,
  summarizeProbes,
  type ProbeResult,
} from "core/util/escapeProbes.js";
import type { TerminalShellPreference } from "core/util/shell.js";

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[key] = true;
    else {
      o[key] = next;
      i++;
    }
  }
  return o;
}

/** `D:\x\y` as `/mnt/d/x/y`: how a WSL distribution names a Windows path. */
function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = String(args.backend ?? "local");
  let terminalShell: TerminalShellPreference | "default";
  if (backend === "wsl") {
    terminalShell = {
      kind: "wsl",
      ...(typeof args.distro === "string" ? { distro: args.distro } : {}),
    };
  } else if (backend === "container") {
    terminalShell = {
      kind: "container",
      ...(typeof args.runtime === "string"
        ? { runtime: args.runtime as "docker" | "podman" }
        : {}),
      ...(typeof args.image === "string" ? { image: args.image } : {}),
    };
  } else if (backend === "local") {
    terminalShell = "default";
  } else {
    console.error(`Unknown backend "${backend}": wsl, container or local.`);
    process.exit(2);
  }

  const executor = getCommandExecutor({ terminalShell });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "probe-workspace-"));
  const canaries = await createCanaries({ listener: args.listener !== false });
  if (backend === "wsl") {
    // The canaries are Windows paths; a distribution names them /mnt/<drive>/...
    // This is the honest question: can the distribution reach them there?
    for (const [k, v] of Object.entries(canaries.vars)) {
      if (
        k !== "canary.key" &&
        k !== "canary.envValue" &&
        /^[A-Za-z]:/.test(v!)
      ) {
        canaries.vars[k as keyof typeof canaries.vars] = toWslPath(v!);
      }
    }
  }

  let only = typeof args.only === "string" ? args.only.split(",") : undefined;
  if (args.offline) {
    only = (only ?? COMMON_PROBES.map((p) => p.id)).filter(
      (id) => id !== "network.public-tcp" && id !== "network.dns",
    );
  }

  let results: ProbeResult[] = [];
  try {
    results = await runProbes(executor, COMMON_PROBES, {
      cwd: workspace,
      canaries,
      only,
      timeoutMs:
        typeof args["timeout-ms"] === "string"
          ? Number(args["timeout-ms"])
          : undefined,
    });
  } finally {
    // A process left running inside a backend can hold a folder open for a moment
    for (const remove of [
      () => canaries.remove(),
      async () =>
        fs.rmSync(workspace, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 300,
        }),
    ]) {
      try {
        await remove();
      } catch (e) {
        console.error(`Could not remove a temporary folder: ${e}`);
      }
    }
  }

  const summary = summarizeProbes(results);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          backend,
          executor: executor.kind,
          describes: executor.describe(),
          unavailable: executor.unavailable,
          at: new Date().toISOString(),
          results,
          summary,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Backend: ${backend} (${executor.describe()})`);
  if (executor.unavailable) console.log(`Unavailable: ${executor.unavailable}`);
  const width = Math.max(...results.map((r) => r.id.length), 4);
  for (const r of results) {
    const first = r.evidence.split("\n")[0] ?? "";
    console.log(
      `${r.verdict.toUpperCase().padEnd(5)} ${r.id.padEnd(width)}  ${r.weak ? "(weak) " : ""}${first}`,
    );
  }
  console.log("");
  for (const [property, status] of Object.entries(summary)) {
    console.log(`${property.padEnd(20)} ${status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
