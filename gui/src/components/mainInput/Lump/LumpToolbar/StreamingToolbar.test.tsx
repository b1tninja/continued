import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import {
  setInactive,
  setPromptProgress,
  setRecoveryHold,
} from "../../../../redux/slices/sessionSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { StreamingToolbar } from "./StreamingToolbar";

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<StreamingToolbar onStop={vi.fn()} />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return store;
}

describe("StreamingToolbar", () => {
  it("says Generating while there is no prompt progress", async () => {
    await setup();
    expect(screen.getByText("Generating")).toBeTruthy();
    expect(screen.queryByTestId("prompt-progress")).toBeNull();
  });

  it("shows how far a local server is in reading the prompt, until it stops", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(
        setPromptProgress({
          total: 300_000,
          cache: 120_000,
          processed: 180_000,
          timeMs: 20_000,
        }),
      );
    });
    expect(screen.getByTestId("prompt-progress").textContent).toContain(
      "Reading the prompt: 60k of 180k tokens, 120k from the cache",
    );

    await act(async () => {
      store.dispatch(setInactive());
    });
    expect(screen.queryByTestId("prompt-progress")).toBeNull();
  });

  it("says the reply is being checked while it is held for tool call recovery, and clears when the hold ends", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setRecoveryHold(true));
    });
    expect(screen.getByTestId("recovery-hold").textContent).toContain(
      "Checking the reply for a tool request",
    );
    expect(screen.queryByText("Generating")).toBeNull();

    await act(async () => {
      store.dispatch(setRecoveryHold(false));
    });
    expect(screen.queryByTestId("recovery-hold")).toBeNull();
    expect(screen.getByText("Generating")).toBeTruthy();
  });

  it("clears the hold line when the stream is stopped or fails", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setRecoveryHold(true));
    });
    await act(async () => {
      store.dispatch(setInactive());
    });
    expect(screen.queryByTestId("recovery-hold")).toBeNull();
  });

  it("adds the elapsed seconds to the hold line after 10 s, not before", async () => {
    vi.useFakeTimers();
    try {
      const store = await setup();
      await act(async () => {
        store.dispatch(setRecoveryHold(true));
      });
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });
      expect(screen.getByTestId("recovery-hold").textContent).not.toContain(
        " s)",
      );
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.getByTestId("recovery-hold").textContent).toContain(
        "(12 s)",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
