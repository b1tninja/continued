import { describe, expect, it, vi } from "vitest";
import type { Session } from "..";
import { compactConversation } from "./conversationCompaction";

function sessionWithCache(): Session {
  return {
    sessionId: "s1",
    title: "t",
    workspaceDirectory: "",
    history: [
      { message: { role: "user", content: "hi" }, contextItems: [] },
      { message: { role: "assistant", content: "hello" }, contextItems: [] },
    ],
    promptCache: {
      lastRequestAt: 1_700_000_000_000,
      lastInputTokens: 366_000,
      lastTtl: "5m",
    },
  };
}

describe("compactConversation", () => {
  it("stores the summary and drops the saved prompt cache record", async () => {
    const session = sessionWithCache();
    const historyManager = {
      load: vi.fn(() => session),
      save: vi.fn(),
    } as any;
    const currentModel = {
      chat: vi.fn(async () => ({ role: "assistant", content: "a summary" })),
    } as any;

    await compactConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel,
    });

    const saved = historyManager.save.mock.calls[0][0] as Session;
    expect(saved.history[1].conversationSummary).toBe("a summary");
    // The conversation is now short, so the old size and time would mislead
    // the cold-cache notice when the session is next opened.
    expect(saved.promptCache).toBeUndefined();
    expect(saved.sessionId).toBe("s1");
  });

  it("does not change the session it was given", async () => {
    const session = sessionWithCache();
    const historyManager = { load: () => session, save: vi.fn() } as any;
    const currentModel = {
      chat: async () => ({ role: "assistant", content: "x" }),
    } as any;
    await compactConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel,
    });
    expect(session.promptCache?.lastInputTokens).toBe(366_000);
  });
});
