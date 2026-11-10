import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
  compareReplayPolicies,
  formatReplayReport,
  normalizeHistory,
  policyMaskBatched,
  policyMaskEveryRequest,
  policyNone,
  syntheticHistory,
} from "./cacheReplay";

/**
 * Prints the offline replay table for one recorded session. Skipped unless
 * REPLAY_INPUT (a session or history JSON file) or REPLAY_SYNTHETIC is set, so
 * the normal run does nothing. Run it through the wrapper:
 *
 *   cd core && npm run replay:ageing -- --input session.json
 *
 * Environment:
 *   REPLAY_INPUT=<path>        session JSON, array of messages, or array of history items
 *   REPLAY_SYNTHETIC=<turns>   a generated long session instead of a file
 *   REPLAY_GAP=<seconds>       gap between requests (default 30)
 *   REPLAY_TTL=<seconds>       cache lifetime (default 300)
 *   REPLAY_TRIGGERS=<a,b,c>    batch triggers in tokens (default 20000,40000,80000)
 *   REPLAY_KEEP=<a,b>          newest tool results kept whole (default 3,5,10)
 *   REPLAY_OUT=<path>          also write the markdown table here
 *
 * No model is called. The numbers come from the cost model in cacheReplay.ts.
 */
const input = process.env.REPLAY_INPUT;
const synthetic = process.env.REPLAY_SYNTHETIC;

function list(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  return raw ? raw.split(",").map(Number).filter(Number.isFinite) : fallback;
}

describe.skipIf(!input && !synthetic)("ageing replay report", () => {
  it("prints the table", () => {
    const history = input
      ? normalizeHistory(JSON.parse(readFileSync(input, "utf8")))
      : syntheticHistory({ turns: Number(synthetic) || 60 });
    const options = {
      gapSeconds: Number(process.env.REPLAY_GAP) || 30,
      ttlSeconds: Number(process.env.REPLAY_TTL) || 300,
    };
    const triggers = list("REPLAY_TRIGGERS", [20000, 40000, 80000]);
    const keeps = list("REPLAY_KEEP", [3, 5, 10]);
    const policies = [
      policyNone,
      ...keeps.map((k) => () => policyMaskEveryRequest({ keepRecent: k })),
      ...triggers.flatMap((t) =>
        keeps.map(
          (k) => () => policyMaskBatched({ triggerTokens: t, keepRecent: k }),
        ),
      ),
    ];
    const text = formatReplayReport(
      compareReplayPolicies(history, policies, options),
    );
    const header = `Replay of ${input ?? `synthetic ${synthetic} turns`}: ${history.length} messages, gap ${options.gapSeconds}s, lifetime ${options.ttlSeconds}s. Cost in units of the base input price; simulated, not measured.\n\n`;
    // eslint-disable-next-line no-console
    console.log(header + text);
    if (process.env.REPLAY_OUT)
      writeFileSync(process.env.REPLAY_OUT, header + text + "\n");
  });
});
