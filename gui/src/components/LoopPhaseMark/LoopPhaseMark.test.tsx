import { act, screen } from "@testing-library/react";
import type { LoopState } from "core";
import { createLoop, startItemRun } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setLoop, setLoopRequested } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { LoopPhaseMark } from "./LoopPhaseMark";

const T0 = new Date("2026-11-09T10:00:00Z");
const base = (): LoopState =>
  createLoop(
    {
      items: [{ id: "1", text: "A", status: "pending" }],
      updatedAt: T0.toISOString(),
    },
    { now: T0, sessionTokens: 0 },
  );

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<LoopPhaseMark label />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  const set = async (loop: LoopState | undefined) =>
    act(async () => {
      store.dispatch(setLoop(loop));
    });
  const phase = () => screen.getByTestId("loop-phase").dataset.phase;
  const angle = () => screen.getByTestId("loop-phase-disc").style.transform;
  return { store, set, phase, angle };
}

describe("LoopPhaseMark", () => {
  it("is at rest with no loop, and planning once Loop is chosen", async () => {
    const { store, phase } = await setup();
    expect(phase()).toBe("idle");
    await act(async () => {
      store.dispatch(setLoopRequested(true));
    });
    expect(phase()).toBe("planning");
  });

  it("turns over between a planning turn and a building turn", async () => {
    const { set, phase, angle } = await setup();
    const running = startItemRun(base(), "1", 0, T0);
    await set(running);
    expect(phase()).toBe("building");
    expect(angle()).toBe("rotate(180deg)");

    await set({
      ...running,
      current: { kind: "replan", startedAt: T0.toISOString(), historyIndex: 0 },
      status: "replanning",
    } as LoopState);
    expect(phase()).toBe("planning");
    expect(angle()).toBe("rotate(0deg)");
    expect(screen.getByTestId("loop-phase").textContent).toContain("Planning");
  });

  it("a plan waiting for the person is still planning", async () => {
    const { set, phase } = await setup();
    await set({ ...base(), status: "awaiting_plan" });
    expect(phase()).toBe("planning");
  });

  it("waiting and stopped keep the half it was on, dimmed", async () => {
    const { set, phase, angle } = await setup();
    await set(startItemRun(base(), "1", 0, T0));
    expect(angle()).toBe("rotate(180deg)");
    await set({ ...base(), status: "waiting" });
    expect(phase()).toBe("waiting");
    expect(angle()).toBe("rotate(180deg)");
    await set({ ...base(), status: "stopped" });
    expect(phase()).toBe("stopped");
    expect(angle()).toBe("rotate(180deg)");
    expect(screen.getByRole("img").getAttribute("style")).toContain(
      "opacity: 0.55",
    );
  });
});
