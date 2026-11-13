import { renderEnvironment } from "../../util/environmentPrompt";
import { baseSnapshot } from "../../util/environmentSnapshot";
import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import {
  terminalToolDescription,
  terminalToolSystemPrefix,
} from "./terminalToolText";
import {
  evaluateTerminalCommandSecurity,
  ToolPolicy,
} from "@continuedev/terminal-security";

/**
 * The shell sentence of the core process's own machine, for a request built
 * before the editor's session has its snapshot. A session's request replaces
 * it with the session's `toolSentence` (`withTerminalToolSentence`), the
 * renderer's text that the CLI's Bash tool uses too. It names no folder.
 */
function processShellSentence(): string {
  try {
    return renderEnvironment(baseSnapshot(), {
      surface: "ide-agent",
      detail: "standard",
    }).toolSentence;
  } catch {
    return "";
  }
}

const PROCESS_SENTENCE = processShellSentence();

export { withTerminalToolSentence } from "./terminalToolText";

export const runTerminalCommandTool: Tool = {
  type: "function",
  displayTitle: "Run Terminal Command",
  wouldLikeTo: "run the following terminal command:",
  isCurrently: "running the following terminal command:",
  hasAlready: "ran the following terminal command:",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.RunTerminalCommand,
    description: terminalToolDescription(PROCESS_SENTENCE),
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description:
            "The command to run. This will be passed directly into the IDE shell.",
        },
        waitForCompletion: {
          type: "boolean",
          description:
            "Whether to wait for the command to complete before returning. Default is true. Set to false to run the command in the background. Set to true to run the command in the foreground and wait to collect the output.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    return evaluateTerminalCommandSecurity(
      basePolicy,
      parsedArgs.command as string,
    );
  },
  systemMessageDescription: {
    prefix: terminalToolSystemPrefix(PROCESS_SENTENCE),
    exampleArgs: [["command", "git log"]],
  },
};
