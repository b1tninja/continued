import {
  noteToolResult,
  untaintSession,
} from "core/tools/permissions/taint/taintWiring.js";

import { CLI_SESSION_ID, toCoreCall } from "./coreRules.js";

/**
 * The CLI's side of the tainted-session rule (plans/design/tainted-session.md).
 * One CLI process is one session for the rule: the main agent and every
 * subagent it starts share this key, so taint reaches a subagent and comes
 * back without any copying. Everything here does nothing while the person's
 * `taintedSessionRule` is `off`, which is the default.
 */
const CLI_TAINT_SESSION = CLI_SESSION_ID;

/** A tool result has entered the conversation: mark the session when the call was a source. */
export function noteCliToolResult(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  mcpServer: string | undefined,
  cwd: string = process.cwd(),
): void {
  try {
    const core = toCoreCall(call.name, call.arguments);
    noteToolResult({
      session: CLI_TAINT_SESSION,
      callId: call.id,
      call: {
        toolName: core?.toolName ?? call.name,
        parsedArgs: core?.parsedArgs ?? call.arguments,
        mcp: !!mcpServer || !!core?.mcp,
        workspaceDirs: [cwd],
      },
    });
  } catch {
    // the taint is a guard; a failure to record it never fails the call
  }
}

/** `/untaint`: the person has reviewed what came in. */
export function handleUntaint(): { exit: false; output: string } {
  const cleared = untaintSession(CLI_TAINT_SESSION, "untaint-command");
  return {
    exit: false,
    output: cleared.length
      ? `Acknowledged: untrusted content from ${cleared.join(", ")} no longer makes network, publish and credential calls ask.`
      : "Nothing to acknowledge: no untrusted content has been marked in this session.",
  };
}
