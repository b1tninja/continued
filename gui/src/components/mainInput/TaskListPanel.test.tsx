import type { TaskPlan } from "core";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setTaskPlan } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { applyUserEdit, moveItem, TaskListPanel } from "./TaskListPanel";

const plan: TaskPlan = {
  items: [
    { id: "1", text: "Write the migration", status: "completed" },
    {
      id: "2",
      text: "Run migrations",
      status: "in_progress",
      activeForm: "Running migrations",
    },
    { id: "3", text: "Deploy", status: "blocked", note: "waiting for keys" },
    { id: "4", text: "Announce", status: "pending", model: "Claude Opus" },
  ],
  updatedAt: "2026-11-06T12:00:00.000Z",
  updatedBy: "model",
};

async function setup(taskPlan: TaskPlan | null = plan) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<TaskListPanel />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(setTaskPlan(taskPlan ?? undefined));
  });
  return store;
}

describe("TaskListPanel", () => {
  it("renders nothing without a list", async () => {
    await setup(null);
    expect(screen.queryByTestId("task-list-panel")).toBeNull();
  });

  it("shows progress collapsed and the items when expanded", async () => {
    await setup();
    expect(screen.getByTestId("task-list-progress").textContent).toBe(
      "1/4 Running migrations",
    );
    expect(screen.queryByTestId("task-item-1")).toBeNull();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    expect(screen.getByTestId("task-item-1").dataset.status).toBe("completed");
    expect(screen.getByTestId("task-text-2").textContent).toBe(
      "Running migrations",
    );
    expect(screen.getByTestId("task-text-3").textContent).toContain(
      "waiting for keys",
    );
    // The model a loop runs the item with, where its other fields show
    expect(screen.getByTestId("task-model-4").textContent).toContain(
      "Claude Opus",
    );
    expect(screen.queryByTestId("task-model-1")).toBeNull();
  });

  it("edits an item's text in place, as the user", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    fireEvent.click(screen.getByTestId("task-edit-4"));
    const input = screen.getByTestId("task-input-4");
    fireEvent.change(input, { target: { value: "Announce in #eng" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const saved = store.getState().session.taskPlan!;
    expect(saved.items.find((i) => i.id === "4")).toMatchObject({
      text: "Announce in #eng",
      // An edit keeps the item's model
      model: "Claude Opus",
    });
    expect(saved.updatedBy).toBe("user");
  });

  it("Escape cancels an edit", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    fireEvent.click(screen.getByTestId("task-edit-4"));
    const input = screen.getByTestId("task-input-4");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.getState().session.taskPlan).toEqual(plan);
  });

  it("starts an item and keeps one item in progress", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    // pending -> in progress; the previous in-progress item goes back to pending
    fireEvent.click(screen.getByTestId("task-start-4"));
    const items = store.getState().session.taskPlan!.items;
    expect(items.find((i) => i.id === "4")?.status).toBe("in_progress");
    expect(items.find((i) => i.id === "2")?.status).toBe("pending");
  });

  it("uses real checkboxes: check to finish, uncheck to reopen", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    const done = screen.getByTestId("task-status-1") as HTMLInputElement;
    expect(done.type).toBe("checkbox");
    expect(done.checked).toBe(true);
    fireEvent.click(done);
    expect(
      store.getState().session.taskPlan!.items.find((i) => i.id === "1")
        ?.status,
    ).toBe("pending");
    fireEvent.click(screen.getByTestId("task-status-4"));
    expect(
      store.getState().session.taskPlan!.items.find((i) => i.id === "4")
        ?.status,
    ).toBe("completed");
  });

  it("does not offer to edit a finished item", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    expect(screen.queryByTestId("task-edit-1")).toBeNull();
    expect(screen.getByTestId("task-edit-2")).toBeTruthy();
    // Clicking the text of a finished item does nothing either
    fireEvent.click(screen.getByTestId("task-text-1"));
    expect(screen.queryByTestId("task-input-1")).toBeNull();
  });

  it("reorders with the keyboard on the grab handle and by dropping", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    const ids = () => store.getState().session.taskPlan!.items.map((i) => i.id);
    fireEvent.keyDown(screen.getByTestId("task-grab-4"), { key: "ArrowUp" });
    expect(ids()).toEqual(["1", "2", "4", "3"]);
    const data: Record<string, string> = { "text/plain": "1" };
    fireEvent.drop(screen.getByTestId("task-item-3"), {
      dataTransfer: { getData: (k: string) => data[k] },
    });
    expect(ids()).toEqual(["2", "4", "3", "1"]);
  });

  it("removes, adds and clears items", async () => {
    const store = await setup();
    fireEvent.click(screen.getByTestId("task-list-toggle"));
    // One click only asks; nothing is removed until it is confirmed
    fireEvent.click(screen.getByTestId("task-delete-3"));
    expect(store.getState().session.taskPlan!.items).toHaveLength(4);
    fireEvent.click(screen.getByTestId("task-delete-3"));
    expect(store.getState().session.taskPlan!.items.map((i) => i.id)).toEqual([
      "1",
      "2",
      "4",
    ]);

    const add = screen.getByTestId("task-list-add");
    fireEvent.change(add, { target: { value: "Write the changelog" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(store.getState().session.taskPlan!.items.at(-1)).toMatchObject({
      id: "5",
      text: "Write the changelog",
      status: "pending",
    });

    fireEvent.click(screen.getByTestId("task-list-clear"));
    expect(store.getState().session.taskPlan).toBeDefined();
    fireEvent.click(screen.getByTestId("task-list-clear"));
    expect(store.getState().session.taskPlan).toBeUndefined();
    expect(screen.queryByTestId("task-list-panel")).toBeNull();
  });
});

describe("applyUserEdit", () => {
  it("drops completed items the person removed", () => {
    const next = applyUserEdit(
      plan,
      plan.items.filter((i) => i.id !== "1"),
    ) as TaskPlan;
    expect(next.items.map((i) => i.id)).toEqual(["2", "3", "4"]);
    expect(next.updatedBy).toBe("user");
  });

  it("reports an invalid edit instead of storing it", () => {
    expect(typeof applyUserEdit(plan, [{ text: " " }])).toBe("string");
  });
});

describe("moveItem", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves and clamps", () => {
    expect(moveItem(list, "c", 0).map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(moveItem(list, "a", 99).map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
  it("returns the same list when nothing moves", () => {
    expect(moveItem(list, "a", 0)).toBe(list);
    expect(moveItem(list, "zz", 1)).toBe(list);
  });
});
