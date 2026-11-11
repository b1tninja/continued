import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setIsInEdit } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import InputToolbar from "../InputToolbar";
import { isInlineToolbarKind } from "./LumpToolbar/LumpToolbar";
import { Lump } from "./index";
import { SessionControls } from "./SessionControls";

async function setup(ui = <Lump />) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(ui, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return { ...view, store };
}

describe("Lump session controls", () => {
  it("holds the mode and policy controls above the input, before the toolbox", async () => {
    await setup();
    const group = screen.getByRole("group", { name: "Session controls" });
    expect(within(group).getByTestId("mode-select-button")).toBeTruthy();
    const controls = within(group).getByTestId("policy-controls");
    expect(within(controls).getByTestId("policy-preset")).toBeTruthy();
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(
        within(controls).getByTestId(`policy-select-${area}`),
      ).toHaveAttribute("aria-label");
    }
    // Focus order: session controls first, toolbox after
    const toolbox = screen.getByTestId("toolbox-toggle");
    expect(
      group.compareDocumentPosition(toolbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("folds the five area dropdowns behind a toggle that reports its state", async () => {
    const { user } = await setup();
    const toggle = screen.getByTestId("policy-areas-toggle");
    const areas = document.getElementById("policy-areas")!;
    expect(toggle).toHaveAttribute("aria-label", "Show policy areas");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(areas.className).toContain("hidden");
    expect(areas.className).toContain("lg:flex");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Hide policy areas");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(areas.className).not.toContain("hidden");
  });

  it("drops the session controls in edit mode, as the bottom row did", async () => {
    const { store } = await setup(<SessionControls />);
    expect(screen.getByTestId("session-controls")).toBeTruthy();
    await act(async () => {
      store.dispatch(setIsInEdit(true));
    });
    expect(screen.queryByTestId("session-controls")).toBeNull();
    expect(screen.queryByTestId("mode-select-button")).toBeNull();
  });

  it("shares the row only with one-line toolbars", () => {
    expect(isInlineToolbarKind("idle")).toBe(true);
    expect(isInlineToolbarKind("streaming")).toBe(true);
    expect(isInlineToolbarKind("terminal")).toBe(true);
    expect(isInlineToolbarKind("pending-tool-calls")).toBe(false);
    expect(isInlineToolbarKind("pending-apply")).toBe(false);
    expect(isInlineToolbarKind("edit")).toBe(false);
  });
});

describe("input bottom row", () => {
  it("keeps the model choice and send, and no longer renders mode or policy", async () => {
    await setup(<InputToolbar activeKey={null} isMainInput />);
    expect(screen.getByTestId("submit-input-button")).toBeTruthy();
    expect(screen.queryByTestId("mode-select-button")).toBeNull();
    expect(screen.queryByTestId("policy-controls")).toBeNull();
  });
});
