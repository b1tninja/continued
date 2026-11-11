/**
 * Prints the srt sandbox-runtime status and the policy preview
 * (plans/ROADMAP.md W4a). A status probe: nothing is sandboxed or installed.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/probeSandboxRuntime.ts
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/probeSandboxRuntime.ts --json
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/probeSandboxRuntime.ts --model-host api.example.com
 *
 * The same output as `continuous sandbox status`, without the CLI's startup.
 */
import { sandboxCommand } from "../src/commands/sandbox.js";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

process.exit(
  sandboxCommand("status", {
    json: args.includes("--json"),
    modelHost: value("--model-host"),
    workspace: value("--workspace"),
  }),
);
