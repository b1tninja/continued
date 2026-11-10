import { type ChildProcess } from "child_process";

import { getCommandExecutor } from "core/util/commandExecutor.js";
import { holdCheck, recordCheck } from "core/util/loopMode.js";

import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import { getSessionLoop } from "../session.js";
import { checkToolPermissionApproval } from "../stream/streamChatResponse.helpers.js";
import { runTerminalCommandTool } from "../tools/runTerminalCommand.js";
import type { PreprocessedToolCall } from "../tools/types.js";
import { logger } from "../util/logger.js";

import { commitLoop } from "./loopSession.js";

/**
 * Loop mode's checks in the CLI: the harness runs an item's `check:` command
 * (TaskItem.check) after the item reported done (core's "check" action). The
 * command goes through the same permission decision as a Bash call the model
 * makes: the person's rules and protected paths decide, a call that would ask
 * is held as an approval question in the inbox (loopHolds.ts, as `current`
 * names the item). A refused one (a rule, the person, or a headless run that
 * cannot ask) leaves the item failed: the check did not run, so it is not
 * done.
 */

/** How long a check may run before it counts as failed. */
export const LOOP_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** Same cap `exec` used: past this, the check is stopped. */
const LOOP_CHECK_MAX_BUFFER = 10 * 1024 * 1024;

export interface LoopCheckStep {
  kind: "check";
  itemId: string;
  command: string;
}

export interface CheckRun {
  exitCode: number | null;
  output: string;
}

/**
 * Runs a command in the workspace and keeps what it printed.
 *
 * It uses the command executor, the same place a Bash call runs: the shell
 * the permission check classified, including WSL or a container. `exec` would
 * use `/bin/sh` (or `cmd.exe` on Windows). An executor that is not available
 * does not fall back to the host shell.
 */
export function runCheckCommand(
  command: string,
  cwd = process.cwd(),
): Promise<CheckRun> {
  return new Promise((resolve) => {
    const executor = getCommandExecutor();
    if (executor.unavailable) {
      resolve({ exitCode: null, output: executor.unavailable });
      return;
    }
    let child: ChildProcess;
    try {
      child = executor.spawn(command, {
        cwd,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, fallback = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const note = timedOut
        ? `(stopped after ${LOOP_CHECK_TIMEOUT_MS / 60000} minutes)`
        : overflow
          ? "stdout maxBuffer length exceeded"
          : "";
      resolve({
        exitCode,
        output: [output, note || fallback].filter(Boolean).join("\n").trim(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, LOOP_CHECK_TIMEOUT_MS);
    const take = (into: "out" | "err", chunk: string) => {
      bytes += chunk.length;
      if (bytes > LOOP_CHECK_MAX_BUFFER) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      if (into === "out") stdout += chunk;
      else stderr += chunk;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => take("out", chunk));
    child.stderr?.on("data", (chunk: string) => take("err", chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) =>
      finish(typeof code === "number" ? code : null),
    );
  });
}

/**
 * Runs the check the loop asked for (nextLoopTurn returned this step, with
 * `current` set by core's startCheck) and records the result.
 */
export async function runLoopCheck(
  step: LoopCheckStep,
  run: (command: string) => Promise<CheckRun> = runCheckCommand,
): Promise<void> {
  const { command } = step;
  const call = {
    id: `loop-check-${step.itemId}`,
    name: runTerminalCommandTool.name,
    arguments: { command },
    argumentsStr: JSON.stringify({ command }),
    startNotified: true,
    tool: runTerminalCommandTool,
  } as PreprocessedToolCall;

  try {
    const permissions = await serviceContainer.get<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );
    const decision = await checkToolPermissionApproval(
      permissions.permissions,
      call,
      undefined,
      services.toolPermissions.isHeadless(),
    );
    if (!decision.approved) {
      const loop = getSessionLoop();
      if (!loop) return;
      commitLoop(
        decision.denialReason === "loop"
          ? holdCheck(loop)
          : recordCheck(
              loop,
              {
                status: "refused",
                command,
                output: decision.denialMessage ?? "A rule refused the command.",
              },
              new Date(),
            ),
      );
      return;
    }

    const result = await run(command);
    const loop = getSessionLoop();
    if (!loop) return;
    commitLoop(
      recordCheck(
        loop,
        {
          status: result.exitCode === 0 ? "passed" : "failed",
          command,
          exitCode: result.exitCode,
          output: result.output,
        },
        new Date(),
      ),
    );
  } catch (error) {
    logger.error("Loop check failed to run", { error });
    const loop = getSessionLoop();
    if (loop?.current?.kind === "check") {
      commitLoop(
        recordCheck(
          loop,
          {
            status: "failed",
            command,
            exitCode: null,
            output: error instanceof Error ? error.message : String(error),
          },
          new Date(),
        ),
      );
    }
  }
}
