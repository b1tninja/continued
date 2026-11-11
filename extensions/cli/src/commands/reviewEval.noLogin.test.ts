import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model" },
  initializeServices: vi.fn(async () => {}),
  // A person who has not signed in: an assistant from config.yaml, no authConfig.
  getService: vi.fn(async () => ({
    assistant: { models: [{ name: "local", model: "m", roles: ["reviewer"] }] },
    authConfig: null,
  })),
}));

vi.mock("../permissions/coreRules.js", () => ({
  reviewerModel: (a: { models: { name: string; model: string }[] }) =>
    a.models[0],
  createReviewer: () => ({
    chat: async () => ({
      content: '{"decision":"ask","reason":"test"}',
    }),
  }),
}));

import { reviewEvalCommand } from "./reviewEval.js";

const DATASET = join(
  __dirname,
  "../../../../core/tools/permissions/auto/evaluation/datasets/reviewer-starter.json",
);

describe("reviewer eval without a login", () => {
  it("builds the reviewer from config.yaml when authConfig is null", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await reviewEvalCommand({
      dataset: DATASET,
      reviewer: "local",
      run: true,
      json: true,
    });
    const errText = err.mock.calls.map((c) => String(c[0])).join("");
    out.mockRestore();
    err.mockRestore();
    expect(errText).not.toContain("No reviewer model is configured");
    expect([0, 1]).toContain(code);
  });
});
