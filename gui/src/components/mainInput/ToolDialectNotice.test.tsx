import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { newSession } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { checkToolDialectLeak } from "../../redux/thunks/noteToolDialectLeak";
import { renderWithProviders } from "../../util/test/render";
import { act, screen } from "./noticeTestUtils";
import { ToolDialectNotice } from "./ToolDialectNotice";

const leaked =
  "I will read it.\n\n<tool_call>\n<function=Read>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>";
const fenced =
  "Example:\n\n```xml\n<tool_call>\n<function=Read>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>\n```\n";

const model = (provider: string, toolDialect?: string) => ({
  title: "Qwen",
  provider,
  model: "qwen.qwen3-coder",
  underlyingProviderName: provider,
  toolDialect,
});

async function setup(reply: string, m = model("bedrock")) {
  const ideMessenger = new MockIdeMessenger();
  const setToolDialect = vi.fn(async () => ({ saved: true }));
  ideMessenger.responseHandlers["config/setToolDialect"] = setToolDialect;
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<ToolDialectNotice />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: { ...EMPTY_CONFIG.selectedModelByRole, chat: m },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [m] },
      } as any),
    );
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          { message: { role: "user", content: "hi" }, contextItems: [] },
          { message: { role: "assistant", content: reply }, contextItems: [] },
        ],
      } as any),
    );
  });
  const check = () =>
    act(async () => {
      checkToolDialectLeak(store.getState(), store.dispatch);
    });
  return { store, check, setToolDialect };
}

describe("ToolDialectNotice", () => {
  it("shows once per model for markup outside a code fence", async () => {
    const { check, store } = await setup(leaked);
    await check();
    expect(screen.getByTestId("tool-dialect-notice").textContent).toContain(
      "This model typed a tool request as plain text, so it did not run. Let Continue read that format for this model?",
    );
    // dismissed, then seen again: not shown a second time
    await act(async () => {
      screen.getByTestId("tool-dialect-notice-dismiss").click();
    });
    await check();
    expect(screen.queryByTestId("tool-dialect-notice")).toBeNull();
    expect(Object.keys(store.getState().session.toolDialectNotices!)).toEqual([
      "Qwen",
    ]);
  });

  it("stays quiet for markup inside a code fence", async () => {
    const { check } = await setup(fenced);
    await check();
    expect(screen.queryByTestId("tool-dialect-notice")).toBeNull();
  });

  it("stays quiet when toolDialect is already set, or the provider cannot recover", async () => {
    const a = await setup(leaked, model("bedrock", "off"));
    await a.check();
    expect(screen.queryByTestId("tool-dialect-notice")).toBeNull();
    const b = await setup(leaked, model("anthropic"));
    await b.check();
    expect(screen.queryByTestId("tool-dialect-notice")).toBeNull();
  });

  it("the action sets toolDialect for that model and never flips on its own", async () => {
    const { check, setToolDialect } = await setup(leaked);
    await check();
    expect(setToolDialect).not.toHaveBeenCalled();
    await act(async () => {
      screen.getByTestId("tool-dialect-turn-on").click();
    });
    expect(setToolDialect).toHaveBeenCalledWith({
      title: "Qwen",
      toolDialect: "qwen-xml",
    });
  });
});
