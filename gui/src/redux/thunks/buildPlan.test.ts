import type { TaskPlan } from "core";
import { describe, expect, it } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import { buildPlan } from "./buildPlan";

const PLAN_URI = "file:///Users/user/workspace1/.continuous/plans/add-retry.md";

const seeded: TaskPlan = {
  items: [
    { id: "1", text: "Add a helper", status: "pending" },
    { id: "2", text: "Use it", status: "pending" },
  ],
  updatedAt: "2026-11-06T12:00:00.000Z",
  updatedBy: "model",
};

function store(fileContents: string | Error) {
  const state = getEmptyRootState();
  state.session.mode = "plan";
  state.session.taskPlan = seeded;
  state.session.planFile = PLAN_URI;
  state.config.config.selectedModelByRole.chat = {
    title: "Test model",
    model: "test-model",
    provider: "anthropic",
    underlyingProviderName: "anthropic",
  };
  const s = createMockStore(state);
  s.mockIdeMessenger.responseHandlers.readFile = async () => {
    if (fileContents instanceof Error) throw fileContents;
    return fileContents;
  };
  return s;
}

function session(s: ReturnType<typeof store>): RootState["session"] {
  return (s.getState() as RootState).session;
}

/**
 * The user message Build added to the history. (The mock messenger answers
 * no LLM requests, so the turn goes no further; what matters is what was sent.)
 */
function sentText(s: ReturnType<typeof store>): string {
  const users = session(s).history.filter(
    (item) => item.message.role === "user",
  );
  expect(users).toHaveLength(1);
  return JSON.stringify(users[0].editorState ?? users[0].message.content);
}

describe("buildPlan", () => {
  it("switches to Agent mode, sends the build message and clears the checklist", async () => {
    const s = store("# Add retry");
    await s.dispatch(buildPlan({ planFile: PLAN_URI }) as any);

    expect(session(s).mode).toBe("agent");
    const text = sentText(s);
    expect(text).toContain(".continuous/plans/add-retry.md");
    expect(text).toContain("Read the file first");
    expect(text).not.toMatch(/task list/i);
    // Only Plan mode makes a checklist: Agent mode just does the work
    expect(session(s).taskPlan).toBeUndefined();
  });
});
