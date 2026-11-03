import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  newSession,
  setPromptCacheState,
} from "../../redux/slices/sessionSlice";
import { setPromptCacheSetting } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";

export const claude = {
  title: "Claude Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
};

/** Renders a component in a store holding a Claude model and one chat message. */
export async function setupNotice(
  component: JSX.Element,
  setting: "auto" | "5m" | "1h" | "off" = "5m",
) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(component, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: claude,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [claude] },
      } as any),
    );
    store.dispatch(
      setPromptCacheSetting({ modelTitle: claude.title, setting }),
    );
    store.dispatch(
      newSession({
        sessionId: "test-session",
        title: "Test",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
          },
        ],
      } as any),
    );
  });
  return { ...view, store, ideMessenger };
}

/** Cache state for a request that started `minutesAgo` minutes ago. */
export const requestedAgo = (minutesAgo: number, extra = {}) => ({
  escalated: false,
  lastRequestAt: Date.now() - minutesAgo * 60_000,
  lastTtl: "5m" as const,
  lastInputTokens: 366_000,
  ...extra,
});

export { act, screen, setPromptCacheState };
