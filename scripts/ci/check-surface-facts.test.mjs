import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateSurfaceFacts } from "./check-surface-facts.mjs";

const real = () =>
  JSON.parse(
    readFileSync(
      new URL("../../core/util/surfaceFacts.generated.json", import.meta.url),
      "utf8",
    ),
  );
const good = {
  value: true,
  level: "declared",
  source: "https://x",
  readOn: "2026-11-10",
};
const file = (facts) => ({
  schemaVersion: 1,
  rows: [{ id: "r", provider: "p", engine: "*", api: "a", facts }],
});

test("the shipped file is valid", () => {
  assert.deepEqual(validateSurfaceFacts(real()), []);
});

test("refuses facts that break the rules", () => {
  const m = { ...good, level: "measured" };
  const cases = {
    "no source": { toolsHonoured: { ...good, source: "" } },
    "no date": { toolsHonoured: { ...good, readOn: undefined } },
    "bad date": { toolsHonoured: { ...good, readOn: "yesterday" } },
    "bad level": { toolsHonoured: { ...good, level: "template" } },
    "measured without k and n": { toolsHonoured: { ...m, runId: "r1" } },
    "measured without run id": { toolsHonoured: { ...m, k: 8, n: 8 } },
    "k above n": { toolsHonoured: { ...m, k: 9, n: 8, runId: "r1" } },
    "k on a declared fact": { toolsHonoured: { ...good, k: 1, n: 1 } },
    "unknown name": { toolsOn: good },
    "measured quantization": {
      quantization: { ...m, value: "fp4", k: 1, n: 1, runId: "r" },
    },
    "bad tool_choice mode": {
      toolChoice: { ...good, value: { sometimes: true } },
    },
  };
  for (const [name, facts] of Object.entries(cases)) {
    assert.ok(validateSurfaceFacts(file(facts)).length > 0, name);
  }
});

test("accepts a measured fact with k, n and a run id", () => {
  const f = { ...good, level: "measured", k: 8, n: 8, runId: "run-1" };
  assert.deepEqual(validateSurfaceFacts(file({ toolsHonoured: f })), []);
});
