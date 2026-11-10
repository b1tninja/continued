import type { Tool } from "../../..";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "../../../tools";

/**
 * The agent's real built-in tool list, taken from core and not written out
 * here: the base definitions plus the config-dependent ones as a non-IDE,
 * non-remote agent session builds them (no experimental tools, tool search
 * off, history ageing at its env default). MCP tools are not included.
 */
export async function realAgentTools(modelName?: string): Promise<Tool[]> {
  const dependent = await getConfigDependentToolDefinitions({
    rules: [],
    enableExperimentalTools: false,
    isRemote: false,
    modelName,
    ide: {} as never,
    toolSearch: "off",
  });
  const seen = new Set<string>();
  return [...getBaseToolDefinitions(), ...dependent].filter((t) => {
    if (seen.has(t.function.name)) return false;
    seen.add(t.function.name);
    return true;
  });
}

export interface WireTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toWireTools(tools: Tool[]): WireTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: (t.function.parameters as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  }));
}

export const CAPTURE_SYSTEM =
  "You are a coding agent working in a repository. When a task needs a tool, call the tool; do not describe the call in prose.";

export interface CapturePrompt {
  id: string;
  /** The tool the prompt is meant to elicit; scoring does not depend on it. */
  expectTool: string;
  text: string;
}

/** Eight prompts, one per kind of call the agent makes most. */
export const CAPTURE_PROMPTS: CapturePrompt[] = [
  {
    id: "read",
    expectTool: "read_file",
    text: "Read the file src/main.ts and tell me what it exports.",
  },
  {
    id: "run",
    expectTool: "run_terminal_command",
    text: "Run `grep -r TODO src` and show me the matches.",
  },
  {
    id: "run-timeout",
    expectTool: "run_terminal_command",
    text: "Run the test suite with `npm test`; it is slow, so let it wait for completion.",
  },
  {
    id: "glob",
    expectTool: "file_glob_search",
    text: "Find every TypeScript test file under packages/.",
  },
  {
    id: "list",
    expectTool: "ls",
    text: "List the files in the docs directory, recursively.",
  },
  {
    id: "create",
    expectTool: "create_new_file",
    text: "Create notes/todo.md containing a three-item checklist about releasing v1.2.",
  },
  {
    id: "plan",
    expectTool: "present_plan",
    text: "Plan a refactor of the login module into three steps, then present the plan for approval.",
  },
  {
    id: "fetch",
    expectTool: "fetch_url_content",
    text: "Fetch https://example.com/changelog and summarise the latest entry.",
  },
];

/** Rough token count: four characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
