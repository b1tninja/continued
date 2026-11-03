import { describe, expect, it } from "vitest";
import { ColdCacheNotice } from "./ColdCacheNotice";
import {
  act,
  requestedAgo,
  screen,
  setPromptCacheState,
  setupNotice,
} from "./noticeTestUtils";

const setup = (setting?: "auto" | "5m" | "1h" | "off") =>
  setupNotice(<ColdCacheNotice />, setting);

describe("ColdCacheNotice", () => {
  it("says what the next message costs once the cache has expired", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(12)));
    });
    const notice = screen.getByTestId("cold-cache-notice");
    expect(notice.textContent).toContain("expired 12 min ago");
    expect(notice.textContent).toContain("366k tokens");
    // 366,000 * $3/MTok * (1.25 - 0.1)
    expect(notice.textContent).toContain("$1.26");
  });

  it("offers compaction, a new session and, for a 5 minute setting, 1 hour", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(12)));
    });
    expect(screen.getByTestId("cold-cache-compact")).toBeInTheDocument();
    expect(screen.getByTestId("cold-cache-new-session")).toBeInTheDocument();
    expect(screen.getByTestId("cold-cache-one-hour")).toBeInTheDocument();
  });

  it("does not offer 1 hour when it is already chosen", async () => {
    const { store } = await setup("1h");
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(90, { lastTtl: "1h" })));
    });
    expect(screen.getByTestId("cold-cache-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("cold-cache-one-hour")).toBeNull();
  });

  it("switches to the 1 hour lifetime on click", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(12)));
    });
    await user.click(screen.getByTestId("cold-cache-one-hour"));
    expect(store.getState().ui.promptCacheSettings["Claude Sonnet"]).toBe("1h");
  });

  it("starts a new session on click", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(12)));
    });
    const before = store.getState().session.id;
    await user.click(screen.getByTestId("cold-cache-new-session"));
    expect(store.getState().session.id).not.toBe(before);
    expect(store.getState().session.history).toHaveLength(0);
  });

  it("is hidden while the cache is warm", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(1)));
    });
    expect(screen.queryByTestId("cold-cache-notice")).toBeNull();
  });

  it("is hidden when caching is off", async () => {
    const { store } = await setup("off");
    await act(async () => {
      store.dispatch(setPromptCacheState(requestedAgo(12)));
    });
    expect(screen.queryByTestId("cold-cache-notice")).toBeNull();
  });

  it("is hidden when the conversation is small", async () => {
    const { store } = await setup();
    await act(async () => {
      store.dispatch(
        setPromptCacheState(requestedAgo(12, { lastInputTokens: 10_000 })),
      );
    });
    expect(screen.queryByTestId("cold-cache-notice")).toBeNull();
  });

  it("stays dismissed for that request and returns after the next one", async () => {
    const { store, user } = await setup();
    const first = requestedAgo(12);
    await act(async () => {
      store.dispatch(setPromptCacheState(first));
    });
    await user.click(screen.getByTestId("cold-cache-notice-dismiss"));
    expect(screen.queryByTestId("cold-cache-notice")).toBeNull();
    await act(async () => {
      store.dispatch(
        setPromptCacheState({
          ...requestedAgo(8),
          dismissedColdFor: first.lastRequestAt,
        }),
      );
    });
    expect(screen.getByTestId("cold-cache-notice")).toBeInTheDocument();
  });
});
