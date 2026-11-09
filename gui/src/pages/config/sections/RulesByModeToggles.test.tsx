import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { RulesByModeToggles } from "./RulesByModeToggles";

async function setup(rulesByMode?: Record<string, boolean>) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<RulesByModeToggles />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG, rulesByMode } as any));
  });
  const request = vi
    .spyOn(ideMessenger, "request")
    .mockResolvedValue({ status: "success", content: { saved: true } } as any);
  return { request };
}

const clickToggle = async (mode: string) => {
  const toggle = screen
    .getByTestId(`rules-mode-${mode}`)
    .querySelector("div[class*='rounded-full']") as HTMLElement;
  await act(async () => {
    toggle.click();
  });
};

describe("RulesByModeToggles", () => {
  it("shows the three modes", async () => {
    await setup();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("turns a mode off by writing false", async () => {
    const { request } = await setup();
    await clickToggle("chat");
    expect(request).toHaveBeenCalledWith("config/setRulesByMode", {
      chat: false,
    });
  });

  it("turns a disabled mode back on by removing the entry", async () => {
    const { request } = await setup({ plan: false });
    await clickToggle("plan");
    expect(request).toHaveBeenCalledWith("config/setRulesByMode", {
      plan: null,
    });
  });
});

describe("RulesByModeToggles: Loop items and re-plans", () => {
  it("are shown beside the modes", async () => {
    await setup({ agent: false });
    expect(screen.getByTestId("rules-mode-loop")).toBeInTheDocument();
    expect(screen.getByText("Loop items")).toBeInTheDocument();
    expect(screen.getByText("Loop re-plans")).toBeInTheDocument();
  });

  it("turning Loop items on while Agent is off writes true, not null", async () => {
    const { request } = await setup({ agent: false });
    await clickToggle("loop");
    expect(request).toHaveBeenCalledWith("config/setRulesByMode", {
      loop: true,
    });
  });

  it("turning Loop items back on removes the entry when Agent is on", async () => {
    const { request } = await setup({ loop: false });
    await clickToggle("loop");
    expect(request).toHaveBeenCalledWith("config/setRulesByMode", {
      loop: null,
    });
  });

  it("turning re-plans off writes false", async () => {
    const { request } = await setup();
    await clickToggle("replan");
    expect(request).toHaveBeenCalledWith("config/setRulesByMode", {
      replan: false,
    });
  });
});
