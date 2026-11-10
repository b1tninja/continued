import { getTerminalShellPreference } from "core/util/shell";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  status: { state: "ready", runtime: "docker" } as any,
  changeListener: undefined as undefined | ((e: any) => void),
  warning: vi.fn(),
  info: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (k: string) => state.config[k],
      inspect: (k: string) => ({ globalValue: state.config[k] }),
    }),
    onDidChangeConfiguration: (cb: (e: any) => void) => {
      state.changeListener = cb;
      return { dispose() {} };
    },
  },
  window: {
    showWarningMessage: state.warning,
    showInformationMessage: state.info,
  },
  env: { clipboard: { writeText: state.clipboard }, openExternal: vi.fn() },
  Uri: { parse: (s: string) => s },
}));

vi.mock("core/util/containerStatus", async (orig) => ({
  ...(await orig<typeof import("core/util/containerStatus")>()),
  pickContainerRuntime: () => state.status,
}));

import { registerTerminalShellSetting } from "./terminalShellSetting";

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("registerTerminalShellSetting (container)", () => {
  beforeEach(() => {
    state.config = {};
    state.status = { state: "ready", runtime: "docker" };
    state.warning.mockReset();
    state.info.mockReset();
    state.clipboard.mockReset();
  });

  it("sets a container preference with runtime and image", async () => {
    state.config = {
      "continuous.terminal.shell": "container",
      "continuous.terminal.containerRuntime": "podman",
      "continuous.terminal.containerImage": " alpine:3 ",
    };
    registerTerminalShellSetting({ subscriptions: [] } as any);
    await flush();
    expect(getTerminalShellPreference()).toEqual({
      kind: "container",
      runtime: "podman",
      image: "alpine:3",
    });
    expect(state.warning).not.toHaveBeenCalled();
  });

  it("auto runtime and empty image leave both unset", async () => {
    state.config = {
      "continuous.terminal.shell": "container",
      "continuous.terminal.containerRuntime": "auto",
      "continuous.terminal.containerImage": "",
    };
    registerTerminalShellSetting({ subscriptions: [] } as any);
    await flush();
    expect(getTerminalShellPreference()).toEqual({ kind: "container" });
  });

  it("keeps the container preference (fails closed) and offers the install hint when not installed", async () => {
    state.status = { state: "not-installed", runtime: "docker" };
    state.warning.mockResolvedValue("Copy install hint");
    state.config = { "continuous.terminal.shell": "container" };
    registerTerminalShellSetting({ subscriptions: [] } as any);
    await flush();
    expect(getTerminalShellPreference()?.kind).toBe("container");
    expect(state.warning).toHaveBeenCalledTimes(1);
    expect(state.warning.mock.calls[0][1]).toBe("Copy install hint");
    expect(state.clipboard.mock.calls[0][0]).toContain("Install Docker");
  });

  it("tells a stopped daemon without an install action", async () => {
    state.status = { state: "installed-but-unusable", runtime: "podman" };
    state.warning.mockResolvedValue(undefined);
    state.config = { "continuous.terminal.shell": "container" };
    registerTerminalShellSetting({ subscriptions: [] } as any);
    await flush();
    expect(state.warning).toHaveBeenCalledTimes(1);
    expect(state.warning.mock.calls[0]).toHaveLength(1);
    expect(getTerminalShellPreference()?.kind).toBe("container");
  });

  it("reapplies when the runtime or image setting changes, and clears on default", async () => {
    state.config = { "continuous.terminal.shell": "container" };
    registerTerminalShellSetting({ subscriptions: [] } as any);
    state.config["continuous.terminal.containerImage"] = "debian:12";
    state.changeListener!({
      affectsConfiguration: (k: string) =>
        k === "continuous.terminal.containerImage",
    });
    expect(getTerminalShellPreference()).toEqual({
      kind: "container",
      image: "debian:12",
    });
    state.config["continuous.terminal.shell"] = "default";
    state.changeListener!({ affectsConfiguration: () => true });
    expect(getTerminalShellPreference()).toBeUndefined();
  });
});
