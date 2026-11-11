import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { TerminalEnvironmentControl } from "./TerminalEnvironmentControl";

const base = {
  mode: "scrub",
  source: "default",
  passEnv: [] as string[],
  allow: [] as string[],
  notices: [] as string[],
  hostEnvNames: ["PATH", "GITHUB_TOKEN", "EDITOR"],
  credentialUrlNames: [] as string[],
};

async function setup(
  status: Record<string, unknown> = {},
  opts: { noProcess?: boolean } = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const set = vi.fn(async () => ({ saved: true }));
  ideMessenger.responseHandlers["config/getTerminalEnvironment"] = vi.fn(
    async () => ({ ...base, ...status }),
  ) as any;
  ideMessenger.responseHandlers["config/setTerminalEnvironment"] = set as any;
  const store = setupStore({ ideMessenger });
  // A webview has no `process`; the build replaces only process.env.NODE_ENV
  // (libraries read it in dev mode). Stand in for that: NODE_ENV works and any
  // other read fails the way it does in the webview.
  const saved = globalThis.process;
  if (opts.noProcess) {
    const webview = new Proxy({ env: { NODE_ENV: "test" } } as object, {
      get(target, key) {
        if (key === "env") return (target as any).env;
        throw new ReferenceError(
          `process.${String(key)}: process is not defined`,
        );
      },
    });
    (globalThis as any).process = webview;
  }
  try {
    await renderWithProviders(<TerminalEnvironmentControl />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {});
  } finally {
    globalThis.process = saved;
  }
  return { set };
}

beforeEach(() => localStorage.clear());

describe("TerminalEnvironmentControl", () => {
  it("shows three options and previews names, never values", async () => {
    await setup();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByTestId("terminal-env-removed").textContent).toContain(
      "GITHUB_TOKEN",
    );
    expect(
      screen.getByTestId("terminal-env-removed").textContent,
    ).not.toContain("EDITOR");
  });

  it("saves the chosen mode to the user's config", async () => {
    const { set } = await setup();
    await act(async () => {
      screen.getByDisplayValue("inherit").click();
    });
    expect(set).toHaveBeenCalledWith({ environment: "inherit" });
  });

  it("saves a pass-through name", async () => {
    const { set } = await setup();
    const input = screen.getByLabelText("Variable name to pass through");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "GITHUB_TOKEN");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByText("Add").click();
    });
    expect(set).toHaveBeenCalledWith({ passEnv: ["GITHUB_TOKEN"] });
  });

  it("is read-only with a reason when CONTINUE_TERMINAL_ENV is set", async () => {
    await setup({ mode: "inherit", source: "env", envVar: "inherit" });
    expect(screen.getByTestId("terminal-env-locked").textContent).toContain(
      "CONTINUE_TERMINAL_ENV",
    );
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByTestId("terminal-env-removed").textContent).toContain(
      "nothing is removed",
    );
  });

  it("shows an ignored-value notice and a dismissible mode note", async () => {
    await setup({ notices: ["terminal.environment: inherit was ignored"] });
    expect(screen.getByTestId("terminal-env-ignored")).toBeInTheDocument();
    await act(async () => {
      screen.getByText("Dismiss").click();
    });
    expect(screen.queryByTestId("terminal-env-note")).toBeNull();
  });
});

describe("TerminalEnvironmentControl in a webview", () => {
  it("renders the preview when there is no `process`", async () => {
    await setup({}, { noProcess: true });
    expect(screen.getByTestId("terminal-env-removed").textContent).toContain(
      "GITHUB_TOKEN",
    );
  });
});
