import type { ModelDescription } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { describe, expect, it, vi } from "vitest";
import {
  createMockStore,
  getEmptyRootState,
} from "../../../util/test/mockStore";
import {
  insertToolboxText,
  sendToolboxText,
  toolboxFactsFromState,
} from "./toolboxActions";

const model: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

const turn = (role: "user" | "assistant", content: string) =>
  ({
    message: { id: `${role}-${content}`, role, content },
    contextItems: [],
  }) as any;

describe("insertToolboxText", () => {
  it("focuses the end of the input and inserts the text after what is there", () => {
    const focus = vi.fn(() => ({}) as any);
    const insertContent = vi.fn();
    const editor = { commands: { focus, insertContent } } as any;
    insertToolboxText(editor, "Reproduce first.");
    expect(focus).toHaveBeenCalledWith("end");
    expect(insertContent).toHaveBeenCalledWith("Reproduce first.");
  });

  it("does nothing when the editor is not ready", () => {
    expect(() => insertToolboxText(null, "text")).not.toThrow();
  });
});

describe("sendToolboxText", () => {
  it("sends the text as the next user message, without touching the input", async () => {
    const state = getEmptyRootState();
    state.config.config = {
      ...state.config.config,
      selectedModelByRole: {
        ...state.config.config.selectedModelByRole,
        chat: model,
      },
    };
    const store = createMockStore(state);
    store.mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "x" }],
      didPrune: false,
      contextPercentage: 0.1,
    };
    await sendToolboxText(store.dispatch as any, "Define done first.");
    const history: any[] = (store.getState() as any).session.history;
    const texts = history.map((item) => renderChatMessage(item.message));
    expect(texts).toContain("Define done first.");
  });
});

describe("toolboxFactsFromState", () => {
  it("takes the first request from the person's messages", () => {
    const facts = toolboxFactsFromState({
      history: [
        turn("user", "Fix the login bug"),
        turn("assistant", "Looking"),
        turn("user", "Also the logout"),
      ],
      loop: undefined,
      taskPlan: undefined,
    });
    expect(facts.request).toBe("Fix the login bug");
    expect(facts.item).toBeUndefined();
  });

  it("takes the running Loop item's text from the plan", () => {
    const facts = toolboxFactsFromState({
      history: [],
      loop: { current: { itemId: "2" } } as any,
      taskPlan: {
        items: [
          { id: "1", text: "Write the lexer", status: "completed" },
          { id: "2", text: "Add tests", status: "pending" },
        ],
        updatedAt: "2026-11-09T00:00:00Z",
      } as any,
    });
    expect(facts.item).toBe("Add tests");
  });

  it("gives nothing for facts the session does not hold", () => {
    expect(
      toolboxFactsFromState({
        history: [],
        loop: undefined,
        taskPlan: undefined,
      }),
    ).toEqual({});
  });
});
