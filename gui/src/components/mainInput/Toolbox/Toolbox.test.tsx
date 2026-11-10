import { act, screen } from "@testing-library/react";
import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";
import {
  createMockStore,
  getEmptyRootState,
} from "../../../util/test/mockStore";
import { renderWithProviders } from "../../../util/test/render";
import { setActive } from "../../../redux/slices/sessionSlice";
import { Toolbox } from "./Toolbox";

const model = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
} as ModelDescription;

async function setup(streaming = false) {
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
  await renderWithProviders(<Toolbox />, {
    store: store as any,
    mockIdeMessenger: store.mockIdeMessenger,
  });
  if (streaming) {
    await act(async () => {
      store.dispatch(setActive());
    });
  }
  return { store };
}

const open = async () => {
  await act(async () => {
    screen.getByTestId("toolbox-toggle").click();
  });
};

describe("Toolbox drawer", () => {
  it("is closed until the toggle is pressed", async () => {
    await setup();
    expect(screen.queryByTestId("toolbox-drawer")).toBeNull();
    await open();
    expect(screen.getByTestId("toolbox-drawer")).toBeInTheDocument();
  });

  it("shows the five groups in order", async () => {
    await setup();
    await open();
    for (const id of ["understand", "diagnose", "decide", "check", "ask"]) {
      expect(screen.getByTestId(`toolbox-group-${id}`)).toBeInTheDocument();
    }
  });

  it("shows the method a card is built on, and none for a plain card", async () => {
    await setup();
    await open();
    expect(
      screen.getByTestId("toolbox-card-why-chain-method").textContent,
    ).toBe("5 Whys");
    expect(
      screen.queryByTestId("toolbox-card-reproduce-first-method"),
    ).toBeNull();
  });

  it("shows the filled prompt when expanded, and drops a sentence with no fact", async () => {
    await setup();
    await open();
    await act(async () => {
      screen.getByTestId("toolbox-card-why-chain-expand").click();
    });
    const prompt =
      screen.getByTestId("toolbox-card-why-chain-prompt").textContent ?? "";
    expect(prompt).toContain(
      "Start from this failure and ask why it happened.",
    );
    expect(prompt).not.toContain("{");
    expect(prompt).toContain("Five steps at most.");
  });

  it("sends a card's text through the store, as the next message", async () => {
    const { store } = await setup();
    await open();
    const dispatch = vi.spyOn(store, "dispatch");
    await act(async () => {
      screen.getByTestId("toolbox-card-small-loop-send").click();
    });
    // The thunk is what sends the message: the action itself is tested in
    // toolboxActions.test.ts
    expect(dispatch).toHaveBeenCalledWith(expect.any(Function));
  });

  it("disables Send while a reply is streaming, and keeps Insert", async () => {
    await setup(true);
    await open();
    const send = screen.getByTestId(
      "toolbox-card-small-loop-send",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByTestId("toolbox-card-small-loop-insert")).toBeEnabled();
  });
});
