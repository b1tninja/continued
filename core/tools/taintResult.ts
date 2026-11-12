import type { Tool, ToolExtras } from "..";
import { resolveShell } from "../util/shell";
import { uriToPath } from "./permissions/names";
import { noteToolResult } from "./permissions/taint/taintWiring";
import { isFileReadTool } from "./permissions/taint/taintSources";

/**
 * The tool result path's one call into the tainted-session rule: after a tool
 * ran, mark the session when the call was a source of untrusted content (a
 * fetch, an MCP result, a read outside the workspace). Does nothing when the
 * person's `taintedSessionRule` is `off`. Never throws.
 */
export async function noteCoreToolResult(
  tool: Tool,
  toolCallId: string | undefined,
  args: Record<string, unknown>,
  extras: Pick<ToolExtras, "ide" | "workspaceDirs">,
): Promise<void> {
  try {
    const dirs =
      extras.workspaceDirs ??
      (isFileReadTool(tool.function.name)
        ? await extras.ide.getWorkspaceDirs()
        : []);
    noteToolResult({
      callId: toolCallId,
      call: {
        toolName: tool.function.name,
        parsedArgs: args,
        mcp: !!tool.uri?.startsWith("mcp:"),
        workspaceDirs: dirs
          .map((d) => (d.startsWith("file:") ? uriToPath(d) : d))
          .filter((d): d is string => !!d),
        shell: resolveShell().kind,
      },
    });
  } catch {
    // the taint is a guard; a failure to record it never fails the call
  }
}
