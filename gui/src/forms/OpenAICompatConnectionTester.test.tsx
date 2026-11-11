import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

function setup(handler: (data: any) => any, model = "m1") {
  const messenger = new MockIdeMessenger();
  messenger.responseHandlers["openaiCompat/testConnection"] = handler;
  const user = userEvent.setup();
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <OpenAICompatConnectionTester
        provider="lmstudio"
        apiBase="http://127.0.0.1:1234/v1"
        model={model}
        canTest
      />
    </IdeMessengerContext.Provider>,
  );
  return user;
}

describe("OpenAICompatConnectionTester", () => {
  it("lists, then probes the first served model when the saved one is not served", async () => {
    const handler = vi.fn(async (data: any) =>
      data.model
        ? {
            ok: true,
            models: ["served-a"],
            template: "Server template looks like qwen-xml (llama.cpp /props).",
            probe: {
              ok: true,
              kind: "native",
              label: "Tool calls: native",
              serverParses: true,
            },
          }
        : { ok: true, models: ["served-a", "served-b"] },
    );
    const user = setup(handler);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("tool-calls-result")).toHaveTextContent(
        "Tool calls: native (served-a)",
      ),
    );
    expect(handler.mock.calls[1][0].model).toBe("served-a");
    expect(screen.getByTestId("tool-calls-template")).toHaveTextContent(
      "qwen-xml",
    );
    expect(screen.getByText(/parses this model's tool calls/)).toBeTruthy();
  });

  it("shows the failure and does not probe", async () => {
    const handler = vi.fn(async () => ({
      ok: false,
      error: "The server rejected the API key (HTTP 401).",
    }));
    const user = setup(handler);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/rejected the API key/);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
