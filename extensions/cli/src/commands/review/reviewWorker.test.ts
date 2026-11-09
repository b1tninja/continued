import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamChatResponse } from "../../stream/streamChatResponse.js";

import { runReview, type WorkerConfig } from "./reviewWorker.js";

/*
 * The review agent's request is the `reviewer` use, so the tail and prompt
 * `modeModels.agent` gives the session's turns (or the short profile's
 * default tail for a small model id) do not reach the fixed review prompt.
 */

vi.mock("../../stream/streamChatResponse.js", () => ({
  streamChatResponse: vi.fn(async () => "No issues found."),
}));
vi.mock("./worktree.js", () => ({
  captureWorktreeDiff: vi.fn(() => ""),
}));
vi.mock("../../services/index.js", () => ({
  initializeServices: vi.fn(async () => undefined),
  getService: vi.fn(async () => ({
    model: { name: "Reviewer", model: "qwen3-coder" },
    llmApi: {},
  })),
  services: {
    chatHistory: {
      addUserMessage: vi.fn(),
      getHistory: vi.fn(() => [
        { message: { role: "user", content: "review" }, contextItems: [] },
      ]),
    },
  },
  SERVICE_NAMES: { MODEL: "model" },
}));

const config: WorkerConfig = {
  agentSource: "owner/review-agent",
  worktreePath: "/tmp/review-worktree",
  diffContext: {
    baseBranch: "main",
    changedFiles: ["a.ts"],
    diff: "+x",
    truncated: false,
  } as WorkerConfig["diffContext"],
  options: {},
};

describe("runReview", () => {
  let chdir: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    chdir = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  });

  afterEach(() => {
    chdir.mockRestore();
  });

  it("makes the agent's request as the reviewer use, not the session's", async () => {
    const result = await runReview(config);

    expect(chdir).toHaveBeenCalledWith("/tmp/review-worktree");
    expect(streamChatResponse).toHaveBeenCalledTimes(1);
    const [, model, , , callbacks, isCompacting, options] =
      vi.mocked(streamChatResponse).mock.calls[0];
    expect(model).toMatchObject({ name: "Reviewer" });
    expect(callbacks).toBeUndefined();
    expect(isCompacting).toBe(false);
    expect(options).toEqual({ use: "reviewer" });
    expect(result).toMatchObject({
      patch: "",
      agentOutput: "No issues found.",
    });
    expect(result.error).toBeUndefined();
  });

  it("reports a failed request as the result's error", async () => {
    vi.mocked(streamChatResponse).mockRejectedValueOnce(new Error("boom"));

    const result = await runReview(config);

    expect(result).toMatchObject({ patch: "", agentOutput: "", error: "boom" });
  });
});
