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
  /** Which lobe the dot is on: left (planning), right (building) or none yet. */
  const lit = () => screen.getByTestId("loop-phase").dataset.lit;
  const dotSide = () =>
    screen.getByTestId("loop-icon-dot").getAttribute("data-side");
  return { store, set, phase, lit, dotSide };
}

describe("LoopPhaseMark", () => {
  it("is at rest with no loop, and planning once Loop is chosen", async () => {
    const { store, phase, lit, dotSide } = await setup();
    expect(phase()).toBe("idle");
    expect(lit()).toBe("none");
    expect(dotSide()).toBe("right");
    await act(async () => {
      store.dispatch(setLoopRequested(true));
    });
    expect(phase()).toBe("planning");
    expect(lit()).toBe("left");
    expect(dotSide()).toBe("left");
  });

  it("puts the dot on the left lobe for planning and the right for building", async () => {
    const { set, phase, dotSide } = await setup();
    const running = startItemRun(base(), "1", 0, T0);
    await set(running);
    expect(phase()).toBe("building");
    expect(dotSide()).toBe("right");

    await set({
      ...running,
      current: { kind: "replan", startedAt: T0.toISOString(), historyIndex: 0 },
      status: "replanning",
    } as LoopState);
    expect(phase()).toBe("planning");
    expect(dotSide()).toBe("left");
    expect(screen.getByTestId("loop-phase").textContent).toContain("Planning");
  });

  it("is one infinity: a single stroke, not two halves", async () => {
    await setup();
    const svg = screen.getByRole("img");
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelectorAll("circle")).toHaveLength(1);
  });

  it("a plan waiting for the person is still planning", async () => {
    const { set, phase } = await setup();
    await set({ ...base(), status: "awaiting_plan" });
    expect(phase()).toBe("planning");
  });

  it("waiting and stopped keep the side it was on, dimmed", async () => {
    const { set, phase, lit } = await setup();
    await set(startItemRun(base(), "1", 0, T0));
    expect(lit()).toBe("right");
    await set({ ...base(), status: "waiting" });
    expect(phase()).toBe("waiting");
    expect(lit()).toBe("right");
    await set({ ...base(), status: "stopped" });
    expect(phase()).toBe("stopped");
    expect(lit()).toBe("right");
    expect(
      screen.getByRole("img").parentElement!.getAttribute("style"),
    ).toContain("opacity: 0.55");
  });
});
