import { setTerminalShellPreference } from "core/util/shell";
import * as vscode from "vscode";

const SHELL = "continuous.terminal.shell";
const DISTRO = "continuous.terminal.wslDistro";

/**
 * Where the agent's terminal commands run: the host's own shell, or, on
 * Windows, bash inside a WSL distribution (plans/isolation.md, W1). Core runs
 * in this process and reads the choice from `core/util/shell`, so the setting
 * is applied now and again whenever it changes.
 */
export function registerTerminalShellSetting(
  context: vscode.ExtensionContext,
): void {
  const apply = () => {
    const config = vscode.workspace.getConfiguration();
    if (config.get<string>(SHELL) === "wsl") {
      const distro = (config.get<string>(DISTRO) ?? "").trim();
      setTerminalShellPreference(
        distro ? { kind: "wsl", distro } : { kind: "wsl" },
      );
    } else {
      setTerminalShellPreference(undefined);
    }
  };
  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SHELL) || e.affectsConfiguration(DISTRO)) {
        apply();
      }
    }),
  );
}
