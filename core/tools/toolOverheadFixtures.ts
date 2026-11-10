import type { MeasuredTool } from "./toolOverhead";

/**
 * Fixture MCP tool lists for the tool-overhead measurement. Modelled on the
 * public servers people install most (filesystem, github, postgres,
 * playwright): same tool names, parameters of the same shape, descriptions
 * of the same length and style. They are written out here, not fetched, so
 * the numbers are the same on every machine. They are not copies of any
 * server's text, so the totals are close to, not equal to, a real install.
 */

type Spec = [
  name: string,
  description: string,
  // "name:type:description"; a trailing "!" on the name marks it required
  ...params: string[],
];

function build(specs: Spec[]): MeasuredTool[] {
  return specs.map(([name, description, ...params]) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of params) {
      const [rawName, type, ...rest] = p.split(":");
      const req = rawName.endsWith("!");
      const key = req ? rawName.slice(0, -1) : rawName;
      if (req) required.push(key);
      properties[key] =
        type === "array"
          ? {
              type: "array",
              items: { type: "string" },
              description: rest.join(":"),
            }
          : { type, description: rest.join(":") };
    }
    return {
      name,
      description,
      parameters: { type: "object", properties, required },
    };
  });
}

const FILESYSTEM = build([
  [
    "read_file",
    "Read the complete contents of a file as text. Handles various text encodings and provides detailed error messages if the file cannot be read. Use this tool when you need to examine the contents of a single file. Only works within allowed directories.",
    "path!:string:Absolute path of the file to read",
    "head:number:If provided, returns only the first N lines of the file",
    "tail:number:If provided, returns only the last N lines of the file",
  ],
  [
    "read_multiple_files",
    "Read the contents of multiple files simultaneously. This is more efficient than reading files one by one when you need to analyze or compare multiple files. Each file's content is returned with its path as a reference. Failed reads for individual files will not stop the entire operation. Only works within allowed directories.",
    "paths!:array:Paths of the files to read",
  ],
  [
    "write_file",
    "Create a new file or completely overwrite an existing file with new content. Use with caution as it will overwrite existing files without warning. Handles text content with proper encoding. Only works within allowed directories.",
    "path!:string:Absolute path of the file to write",
    "content!:string:Full text content of the file",
  ],
  [
    "edit_file",
    "Make line-based edits to a text file. Each edit replaces exact line sequences with new content. Returns a git-style diff showing the changes made. Only works within allowed directories.",
    "path!:string:Absolute path of the file to edit",
    "edits!:array:List of edits, each with oldText and newText",
    "dryRun:boolean:Preview changes using git-style diff format",
  ],
  [
    "create_directory",
    "Create a new directory or ensure a directory exists. Can create multiple nested directories in one operation. If the directory already exists, this operation will succeed silently. Only works within allowed directories.",
    "path!:string:Absolute path of the directory to create",
  ],
  [
    "list_directory",
    "Get a detailed listing of all files and directories in a specified path. Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes. This tool is essential for understanding directory structure and finding specific files within a directory. Only works within allowed directories.",
    "path!:string:Absolute path of the directory to list",
  ],
  [
    "list_directory_with_sizes",
    "Get a detailed listing of all files and directories in a specified path, including sizes. Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes. This tool is useful for understanding directory structure and finding specific files within a directory. Only works within allowed directories.",
    "path!:string:Absolute path of the directory to list",
    "sortBy:string:Sort entries by name or size",
  ],
  [
    "directory_tree",
    "Get a recursive tree view of files and directories as a JSON structure. Each entry includes name, type (file or directory) and children for directories. Files have no children array, while directories always have a children array (which may be empty). The output is formatted with 2 space indentation for readability. Only works within allowed directories.",
    "path!:string:Absolute path of the directory to show",
    "excludePatterns:array:Glob patterns to leave out",
  ],
  [
    "move_file",
    "Move or rename files and directories. Can move files between directories and rename them in a single operation. If the destination exists, the operation will fail. Works across different directories and can be used for simple renaming within the same directory. Both source and destination must be within allowed directories.",
    "source!:string:Path to move from",
    "destination!:string:Path to move to",
  ],
  [
    "search_files",
    "Recursively search for files and directories matching a pattern. Searches through all subdirectories from the starting path. The search is case-insensitive and matches partial names. Returns full paths to all matching items. Great for finding files when you don't know their exact location. Only searches within allowed directories.",
    "path!:string:Directory to start in",
    "pattern!:string:Name pattern to match",
    "excludePatterns:array:Glob patterns to leave out",
  ],
  [
    "get_file_info",
    "Retrieve detailed metadata about a file or directory. Returns comprehensive information including size, creation time, last modified time, permissions, and type. This tool is perfect for understanding file characteristics without reading the actual content. Only works within allowed directories.",
    "path!:string:Absolute path of the file or directory",
  ],
  [
    "list_allowed_directories",
    "Returns the list of directories that this server is allowed to access. Subdirectories within these allowed directories are also accessible. Use this to understand which directories are available before trying to access files.",
  ],
]);

const GITHUB = build([
  [
    "create_or_update_file",
    "Create or update a single file in a GitHub repository. If updating, you must provide the SHA of the file you want to update.",
    "owner!:string:Repository owner (username or organization)",
    "repo!:string:Repository name",
    "path!:string:Path where to create or update the file",
    "content!:string:Content of the file",
    "message!:string:Commit message",
    "branch!:string:Branch to create or update the file in",
    "sha:string:SHA of the file being replaced (required when updating existing files)",
  ],
  [
    "search_repositories",
    "Search for GitHub repositories matching a query, with qualifiers such as language, stars and topic.",
    "query!:string:Search query (see GitHub search syntax)",
    "page:number:Page number for pagination (default: 1)",
    "perPage:number:Number of results per page (default: 30, max: 100)",
  ],
  [
    "create_repository",
    "Create a new GitHub repository in your account.",
    "name!:string:Repository name",
    "description:string:Repository description",
    "private:boolean:Whether the repository should be private",
    "autoInit:boolean:Initialize with README.md",
  ],
  [
    "get_file_contents",
    "Get the contents of a file or directory from a GitHub repository.",
    "owner!:string:Repository owner (username or organization)",
    "repo!:string:Repository name",
    "path!:string:Path to the file or directory",
    "branch:string:Branch to get contents from",
  ],
  [
    "push_files",
    "Push multiple files to a GitHub repository in a single commit.",
    "owner!:string:Repository owner (username or organization)",
    "repo!:string:Repository name",
    "branch!:string:Branch to push to (e.g., 'main' or 'master')",
    "files!:array:Array of files to push",
    "message!:string:Commit message",
  ],
  [
    "create_issue",
    "Create a new issue in a GitHub repository.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "title!:string:Issue title",
    "body:string:Issue body",
    "assignees:array:Usernames to assign",
    "labels:array:Labels to add",
    "milestone:number:Milestone number",
  ],
  [
    "create_pull_request",
    "Create a new pull request in a GitHub repository.",
    "owner!:string:Repository owner (username or organization)",
    "repo!:string:Repository name",
    "title!:string:Pull request title",
    "body:string:Pull request body/description",
    "head!:string:The name of the branch where your changes are implemented",
    "base!:string:The name of the branch you want the changes pulled into",
    "draft:boolean:Whether to create the pull request as a draft",
    "maintainer_can_modify:boolean:Whether maintainers can modify the pull request",
  ],
  [
    "fork_repository",
    "Fork a GitHub repository to your account or specified organization.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "organization:string:Optional organization to fork to (defaults to your personal account)",
  ],
  [
    "create_branch",
    "Create a new branch in a GitHub repository.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "branch!:string:Name for the new branch",
    "from_branch:string:Optional source branch (defaults to the repo default)",
  ],
  [
    "list_commits",
    "Get list of commits of a branch in a GitHub repository.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "page:number:Page number",
    "perPage:number:Results per page",
    "sha:string:Branch name or SHA",
  ],
  [
    "list_issues",
    "List issues in a GitHub repository with filtering options.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "state:string:open, closed or all",
    "labels:array:Labels to filter by",
    "sort:string:created, updated or comments",
    "direction:string:asc or desc",
    "since:string:ISO 8601 timestamp",
    "page:number:Page number",
    "per_page:number:Results per page",
  ],
  [
    "update_issue",
    "Update an existing issue in a GitHub repository.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "issue_number!:number:Issue number to update",
    "title:string:New title",
    "body:string:New description",
    "state:string:New state (open or closed)",
    "labels:array:New labels",
    "assignees:array:New assignees",
    "milestone:number:New milestone number",
  ],
  [
    "add_issue_comment",
    "Add a comment to an existing issue.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "issue_number!:number:Issue number to comment on",
    "body!:string:Comment text",
  ],
  [
    "search_code",
    "Search for code across GitHub repositories.",
    "q!:string:Search query using GitHub code search syntax",
    "order:string:Sort order (asc or desc)",
    "page:number:Page number",
    "per_page:number:Results per page (max 100)",
  ],
  [
    "search_issues",
    "Search for issues and pull requests across GitHub repositories.",
    "q!:string:Search query using GitHub issues search syntax",
    "order:string:Sort order",
    "page:number:Page number",
    "per_page:number:Results per page (max 100)",
    "sort:string:Sort field",
  ],
  [
    "search_users",
    "Search for users on GitHub.",
    "q!:string:Search query using GitHub user search syntax",
    "order:string:Sort order",
    "page:number:Page number",
    "per_page:number:Results per page (max 100)",
    "sort:string:Sort field (followers, repositories, joined)",
  ],
  [
    "get_issue",
    "Get details of a specific issue in a GitHub repository.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "issue_number!:number:Issue number",
  ],
  [
    "get_pull_request",
    "Get details of a specific pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
  ],
  [
    "list_pull_requests",
    "List and filter repository pull requests.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "state:string:State of the pull requests",
    "head:string:Filter by head user or head organization and branch name",
    "base:string:Filter by base branch name",
    "sort:string:What to sort results by",
    "direction:string:The direction of the sort",
    "per_page:number:Results per page",
    "page:number:Page number",
  ],
  [
    "create_pull_request_review",
    "Create a review on a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
    "body!:string:The body text of the review",
    "event!:string:The review action (APPROVE, REQUEST_CHANGES, COMMENT)",
    "commit_id:string:The SHA of the commit that needs a review",
    "comments:array:Line-specific comments",
  ],
  [
    "merge_pull_request",
    "Merge a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
    "commit_title:string:Title for the automatic commit message",
    "commit_message:string:Extra detail to append to the commit message",
    "merge_method:string:Merge method (merge, squash, rebase)",
  ],
  [
    "get_pull_request_files",
    "Get the list of files changed in a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
  ],
  [
    "get_pull_request_status",
    "Get the combined status of all status checks for a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
  ],
  [
    "update_pull_request_branch",
    "Update a pull request branch with the latest changes from the base branch.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
    "expected_head_sha:string:The expected SHA of the pull request's HEAD ref",
  ],
  [
    "get_pull_request_comments",
    "Get the review comments on a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
  ],
  [
    "get_pull_request_reviews",
    "Get the reviews on a pull request.",
    "owner!:string:Repository owner",
    "repo!:string:Repository name",
    "pull_number!:number:Pull request number",
  ],
]);

const POSTGRES = build([
  [
    "query",
    "Run a read-only SQL query against the connected PostgreSQL database. The query runs inside a read-only transaction. Returns the rows as JSON.",
    "sql!:string:The SQL query to run",
  ],
  [
    "list_tables",
    "List the tables in the connected database with their schema names and row estimates.",
    "schema:string:Schema to list (default: public)",
  ],
  [
    "describe_table",
    "Describe a table: columns, types, nullability, defaults, primary and foreign keys and indexes.",
    "table!:string:Table name",
    "schema:string:Schema name (default: public)",
  ],
]);

const PLAYWRIGHT = build([
  ["browser_close", "Close the page"],
  [
    "browser_resize",
    "Resize the browser window",
    "width!:number:Width of the browser window",
    "height!:number:Height of the browser window",
  ],
  [
    "browser_console_messages",
    "Returns all console messages",
    "onlyErrors:boolean:Only return error messages",
  ],
  [
    "browser_handle_dialog",
    "Handle a dialog",
    "accept!:boolean:Whether to accept the dialog.",
    "promptText:string:The text of the prompt in case of a prompt dialog.",
  ],
  [
    "browser_evaluate",
    "Evaluate JavaScript expression on page or element",
    "function!:string:() => { /* code */ } or (element) => { /* code */ } when element is provided",
    "element:string:Human-readable element description used to obtain permission to interact with the element",
    "ref:string:Exact target element reference from the page snapshot",
  ],
  [
    "browser_file_upload",
    "Upload one or multiple files",
    "paths!:array:The absolute paths to the files to upload. Can be a single file or multiple files.",
  ],
  [
    "browser_fill_form",
    "Fill multiple form fields",
    "fields!:array:Fields to fill in",
  ],
  [
    "browser_install",
    "Install the browser specified in the config. Call this if you get an error about the browser not being installed.",
  ],
  [
    "browser_press_key",
    "Press a key on the keyboard",
    "key!:string:Name of the key to press or a character to generate, such as `ArrowLeft` or `a`",
  ],
  [
    "browser_type",
    "Type text into editable element",
    "element!:string:Human-readable element description used to obtain permission to interact with the element",
    "ref!:string:Exact target element reference from the page snapshot",
    "text!:string:Text to type into the element",
    "submit:boolean:Whether to submit entered text (press Enter after)",
    "slowly:boolean:Whether to type one character at a time",
  ],
  [
    "browser_navigate",
    "Navigate to a URL",
    "url!:string:The URL to navigate to",
  ],
  ["browser_navigate_back", "Go back to the previous page"],
  [
    "browser_network_requests",
    "Returns all network requests since loading the page",
  ],
  [
    "browser_take_screenshot",
    "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
    "type:string:Image format for the screenshot. Default is png.",
    "filename:string:File name to save the screenshot to",
    "element:string:Human-readable element description",
    "ref:string:Exact target element reference from the page snapshot",
    "fullPage:boolean:When true, takes a screenshot of the full scrollable page",
  ],
  [
    "browser_snapshot",
    "Capture accessibility snapshot of the current page, this is better than screenshot",
  ],
  [
    "browser_click",
    "Perform click on a web page",
    "element!:string:Human-readable element description used to obtain permission to interact with the element",
    "ref!:string:Exact target element reference from the page snapshot",
    "doubleClick:boolean:Whether to perform a double click instead of a single click",
    "button:string:Button to click, defaults to left",
  ],
  [
    "browser_drag",
    "Perform drag and drop between two elements",
    "startElement!:string:Human-readable source element description",
    "startRef!:string:Exact source element reference from the page snapshot",
    "endElement!:string:Human-readable target element description",
    "endRef!:string:Exact target element reference from the page snapshot",
  ],
  [
    "browser_hover",
    "Hover over element on page",
    "element!:string:Human-readable element description",
    "ref!:string:Exact target element reference from the page snapshot",
  ],
  [
    "browser_select_option",
    "Select an option in a dropdown",
    "element!:string:Human-readable element description",
    "ref!:string:Exact target element reference from the page snapshot",
    "values!:array:Array of values to select in the dropdown.",
  ],
  [
    "browser_tabs",
    "List, create, close, or select a browser tab.",
    "action!:string:Operation to perform",
    "index:number:Tab index, used for close/select. If omitted for close, current tab is closed.",
  ],
  [
    "browser_wait_for",
    "Wait for text to appear or disappear or a specified time to pass",
    "time:number:The time to wait in seconds",
    "text:string:The text to wait for",
    "textGone:string:The text to wait for to disappear",
  ],
]);

const ALL = [...FILESYSTEM, ...GITHUB, ...POSTGRES, ...PLAYWRIGHT];

export interface McpFixture {
  label: string;
  tools: MeasuredTool[];
}

/** 5, 20 and 60 tools: the filesystem server's five most used, filesystem plus eight GitHub, and 60 of all four. */
export const MCP_FIXTURES: McpFixture[] = [
  {
    label: "mcp-5",
    tools: [
      "read_file",
      "write_file",
      "list_directory",
      "search_files",
      "edit_file",
    ].map((n) => FILESYSTEM.find((t) => t.name === n)!),
  },
  { label: "mcp-20", tools: [...FILESYSTEM, ...GITHUB.slice(0, 8)] },
  { label: "mcp-60", tools: ALL.slice(0, 60) },
];

export const ALL_FIXTURE_TOOLS = ALL;
