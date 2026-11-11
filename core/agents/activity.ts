import type { AgentActivity } from "./types";

const READ = new Set([
  "read",
  "read_file",
  "read_file_range",
  "read_currently_open_file",
  "ls",
  "list",
  "diff",
  "view_diff",
  "view_repo_map",
  "view_subdirectory",
  "read_skill",
  "skills",
]);
const SEARCH = new Set([
  "search",
  "grep_search",
  "file_glob_search",
  "codebase",
  "code_navigation",
  "search_tools",
]);
const EDIT = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "write",
  "edit_existing_file",
  "single_find_and_replace",
  "create_new_file",
]);
const RUN = new Set(["bash", "run_terminal_command"]);
const FETCH = new Set(["fetch", "fetch_url_content", "search_web"]);

/**
 * The words for what a tool call is: picked by the tool's name from a fixed
 * list, so the arguments are never read. A tool that is not listed (an MCP
 * tool, say) is "working": its name is not echoed either.
 */
export function activityForTool(name: string | undefined): AgentActivity {
  const key = (name ?? "").toLowerCase();
  if (READ.has(key)) return "reading files";
  if (SEARCH.has(key)) return "searching";
  if (EDIT.has(key)) return "editing";
  if (RUN.has(key)) return "running a command";
  if (FETCH.has(key)) return "fetching";
  return "working";
}
