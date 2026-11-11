import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  SCENARIOS,
  buildCliScenario,
  enterScenarioDir,
} from "./segmentScenarios.js";

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(async () => ({ config: { rules: [] } })),
    getSync: vi.fn(() => ({ value: undefined })),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

beforeAll(() => enterScenarioDir());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function run(env: string | undefined): Promise<string> {
  vi.stubEnv("CONTINUE_PROMPT_SEGMENTS", env ?? "");
  vi.resetModules();
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { dumpPromptSegments } = await import("./segmentDump.js");
  const spec = SCENARIOS["cli-agent"];
  const r = await buildCliScenario(spec);
  const args = {
    body: { model: "claude-sonnet-4-6", messages: r.messages } as never,
    systemMessage: r.systemMessage,
    tools: r.tools,
    taskListBlock: spec.taskListBlock,
  };
  dumpPromptSegments(args);
  dumpPromptSegments(args);
  return write.mock.calls.map((c) => String(c[0])).join("");
}

describe("CONTINUE_PROMPT_SEGMENTS", () => {
  it("prints nothing when unset", async () => {
    expect(await run(undefined)).toBe("");
  });

  it("prints one line per segment and the change cause, never contents", async () => {
    const out = await run("1");
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^\[prompt-segments\] req=1 model=claude/);
    expect(out).toMatch(/turn\.act@full region=system stability=static/);
    expect(out).toContain("first_changed_vs_prev=first");
    expect(out).toContain("first_changed_vs_prev=none");
    expect(out).not.toContain("You are an agent in the Continuous CLI");
    expect(out).not.toContain("Prefer named exports");
  });
});
