import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCheckIn,
  CHECK_IN_GUIDANCE,
  CheckInGate,
  fisherOneSided,
  HEALTHY_CONTROL_SCENARIOS,
  scoreExperiment,
  STUCK_EXPERIMENT,
  STUCK_SCENARIO,
  type ExperimentRun,
} from "./stuckExperiment";
import { detectStuck, type StuckStep } from "./stuckSignals";
import { TOOLBOX_CARDS } from "./toolboxCards";

const ERR =
  "AssertionError: limit() is 3, expected 5 (configured in src/config.js)";

/** The decoy scenario as a scripted history: edit the stale file, run, same failure. */
function decoyHistory(edits: number): StuckStep[] {
  const steps: StuckStep[] = [
    {
      calls: [
        {
          tool: "read_file",
          args: { filepath: "README.md" },
          read: ["README.md"],
          result: "Request limits are configured in src/config.js.",
        },
      ],
    },
  ];
  for (let i = 0; i < edits; i++) {
    steps.push({
      calls: [
        {
          tool: "edit",
          args: {
            file_path: "src/config.js",
            old_string: `limit = ${i + 3}`,
            new_string: `limit = ${i + 4}`,
          },
          result: "ok",
          changed: [{ path: "src/config.js", hash: `h${i}` }],
        },
      ],
    });
    steps.push({
      calls: [
        {
          tool: "run_terminal_command",
          args: { command: "npm test" },
          result: ERR,
          error: true,
        },
      ],
    });
  }
  return steps;
}

describe("the decoy history", () => {
  const level = (n: number) => detectStuck(decoyHistory(n));
  const kind = (n: number) =>
    level(n).signals.find((s) => s.kind === "persistent-failure");

  it("was invisible to the repeat signals: every edit resets their counts", () => {
    // The blind spot found in plans/stuck-calibration.md: 8 edits, 8 identical failures
    const others = level(8).signals.filter(
      (s) => s.kind !== "persistent-failure",
    );
    expect(others).toEqual([]);
  });

  it("is caught by persistent-failure: a note at the fourth failure, stuck at the sixth", () => {
    expect(kind(3)).toBeUndefined();
    expect(kind(4)?.level).toBe("note");
    expect(kind(5)?.level).toBe("note");
    expect(kind(6)?.level).toBe("stuck");
    expect(level(6).level).toBe("stuck");
  });

  it("stays quiet when the failure changes with the edits, or the fix lands", () => {
    const moving = decoyHistory(6).map((s, i) =>
      s.calls[0].error
        ? {
            calls: [
              {
                ...s.calls[0],
                result: `TypeError: step ${"abcdef"[i % 6]} is not a function`,
              },
            ],
          }
        : s,
    );
    expect(detectStuck(moving).signals).toEqual([]);

    const fixed = decoyHistory(5);
    fixed.push({
      calls: [
        {
          tool: "edit",
          args: { file_path: "src/settings.js" },
          result: "ok",
          changed: [{ path: "src/settings.js", hash: "s1" }],
        },
        {
          tool: "run_terminal_command",
          args: { command: "npm test" },
          result: "pass",
        },
      ],
    });
    expect(detectStuck(fixed).level).toBe("none");
  });
});

describe("the check-in", () => {
  it("carries the log, what repeated and one guidance line, and asks for a change", () => {
    const steps = decoyHistory(6);
    const text = buildCheckIn(steps, detectStuck(steps));
    expect(text).toContain("What has been tried:");
    expect(text).toContain("edit src/config.js");
    expect(text).toContain("across 5 edits");
    expect(text).toContain(CHECK_IN_GUIDANCE["persistent-failure"].line);
    expect(text).toMatch(/Change your approach/);
  });

  it("is undefined when nothing is wrong", () => {
    expect(
      buildCheckIn(decoyHistory(1), detectStuck(decoyHistory(1))),
    ).toBeUndefined();
  });

  it("names a toolbox card that exists for every signal", () => {
    const ids = new Set(TOOLBOX_CARDS.map((c) => c.id));
    for (const g of Object.values(CHECK_IN_GUIDANCE)) {
      expect(ids.has(g.card)).toBe(true);
    }
  });

  it("fires once per episode and re-arms after quiet steps", () => {
    const gate = new CheckInGate();
    const stuck = detectStuck(decoyHistory(6));
    const none = detectStuck([]);
    expect(gate.due(stuck)).toBe(true);
    expect(gate.due(stuck)).toBe(false);
    for (let i = 0; i < STUCK_EXPERIMENT.rearmAfterQuietSteps - 1; i++) {
      gate.due(none);
    }
    expect(gate.due(stuck)).toBe(false);
    for (let i = 0; i < STUCK_EXPERIMENT.rearmAfterQuietSteps; i++) {
      gate.due(none);
    }
    expect(gate.due(stuck)).toBe(true);
  });
});

describe("fisherOneSided", () => {
  it("matches the worked values the plan quotes", () => {
    expect(fisherOneSided(8, 10, 3, 10)).toBeCloseTo(0.0349, 3);
    expect(fisherOneSided(7, 10, 4, 10)).toBeGreaterThan(
      STUCK_EXPERIMENT.fisherAlpha,
    );
    expect(fisherOneSided(5, 10, 5, 10)).toBeGreaterThan(0.5);
    expect(fisherOneSided(10, 10, 0, 10)).toBeLessThan(0.001);
  });
});

function runs(
  model: string,
  control: number,
  treat: number,
  tokens = { none: 100, checkin: 100 },
): ExperimentRun[] {
  const n = STUCK_EXPERIMENT.runsPerArm;
  const mk = (arm: "none" | "checkin", ok: number): ExperimentRun[] =>
    Array.from({ length: n }, (_, i) => ({
      model,
      arm,
      scenario: STUCK_SCENARIO,
      recovered: i < ok,
      tokens: tokens[arm],
    }));
  return [...mk("none", control), ...mk("checkin", treat)];
}

function controlRuns(fired: number): ExperimentRun[] {
  return HEALTHY_CONTROL_SCENARIOS.flatMap((scenario, si) =>
    Array.from(
      { length: STUCK_EXPERIMENT.controlRunsPerScenario },
      (_, i): ExperimentRun => ({
        model: "m",
        arm: "checkin",
        scenario,
        recovered: true,
        tokens: 100,
        fired: si === 0 && i < fired,
      }),
    ),
  );
}

describe("scoreExperiment", () => {
  it("passes when both models lift, cost stays in bounds and controls stay quiet", () => {
    const v = scoreExperiment([
      ...runs("local", 3, 8),
      ...runs("hosted", 2, 8),
      ...controlRuns(1),
    ]);
    expect(v.status).toBe("pass");
    expect(v.healthyFire.rate).toBeCloseTo(0.05);
  });

  it("fails on a lift in one model only", () => {
    const v = scoreExperiment([
      ...runs("local", 3, 8),
      ...runs("hosted", 3, 3),
      ...controlRuns(0),
    ]);
    expect(v.status).toBe("fail");
    expect(v.reasons.join(" ")).toContain("hosted: lift");
  });

  it("fails on cost and on false alarms", () => {
    const dear = scoreExperiment([
      ...runs("a", 3, 8, { none: 100, checkin: 130 }),
      ...runs("b", 3, 8),
      ...controlRuns(0),
    ]);
    expect(dear.status).toBe("fail");
    expect(dear.reasons.join(" ")).toContain("a: cost");
    const noisy = scoreExperiment([
      ...runs("a", 3, 8),
      ...runs("b", 3, 8),
      ...controlRuns(3),
    ]);
    expect(noisy.status).toBe("fail");
    expect(noisy.reasons.join(" ")).toContain("healthy control");
  });

  it("says uninformative when the control is at the floor or the ceiling", () => {
    const v = scoreExperiment([
      ...runs("a", 0, 6),
      ...runs("b", 3, 8),
      ...controlRuns(0),
    ]);
    expect(v.status).toBe("uninformative");
  });

  it("says incomplete for too few models or runs", () => {
    expect(
      scoreExperiment([...runs("a", 3, 8), ...controlRuns(0)]).status,
    ).toBe("incomplete");
    expect(scoreExperiment(runs("a", 3, 8).slice(2)).status).toBe("incomplete");
  });
});

describe("the scenario", () => {
  const bench = path.resolve(__dirname, "../../bench");
  const scenario = JSON.parse(
    fs.readFileSync(path.join(bench, "scenarios", "stuck-decoy.json"), "utf8"),
  );

  it("is the one the experiment names, with its budget", () => {
    expect(scenario.name).toBe(STUCK_SCENARIO);
    expect(scenario.budget.maxRequests).toBe(STUCK_EXPERIMENT.maxRequests);
  });

  it("has a seed whose decoy and real settings agree, so the first edit looks right and does nothing", () => {
    const seed = path.join(bench, scenario.seed.from);
    const read = (f: string) => fs.readFileSync(path.join(seed, f), "utf8");
    expect(read("src/config.js")).toContain("limit = 3");
    expect(read("src/settings.js")).toContain("limit = 3");
    expect(read("src/app.js")).toContain("./settings.js");
    expect(read("src/app.js")).not.toContain("src/config.js");
    expect(read("README.md")).toContain("src/config.js");
    expect(read("test/limit.test.js")).toContain("configured in src/config.js");
  });
});
