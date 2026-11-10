import type { ChatHistoryItem, ToolCallState } from "../index.js";
import { renderChatMessage } from "./messageContent.js";
import type { StuckCall, StuckStep } from "./stuckSignals.js";

/**
 * Host adapters for the stuck signals (plans/stuck-detection.md, S1): they turn
 * a host's chat history into the host-free `StuckStep[]` the signals read.
 *
 * Both hosts keep a `ChatHistoryItem[]`, but they record a tool call
 * differently:
 *
 * - the CLI (and anything that sends the history to a model) keeps the
 *   assistant message with `toolCalls` (JSON-text arguments) and the result in
 *   a later `role: "tool"` item, joined by `toolCallId`;
 * - the IDE (core/gui) keeps `toolCallStates` on the assistant item, with the
 *   parsed arguments, a status and the output as context items.
 *
 * What an adapter cannot know is approximated, and the approximations are the
 * ones to remember when reading a measurement:
 *
 * - a call "failed" if the host says so (`errored` status) or, for the CLI,
 *   if its result text starts like an error (see `looksLikeError`);
 * - "changed" is derived from the arguments of the edit tools, never from the
 *   disk. A full write hashes the content; an edit applies its replacement to
 *   a virtual copy of the file that starts as the text the edit replaced, so
 *   an edit and its reverse come back to the same hash, but two unrelated
 *   edits to one file do not;
 * - "read" is the path argument of a read tool.
 */

/** Names of the tools by what they do, across the CLI's and the IDE's. */
const READ_TOOLS = new Set([
  "read",
  "read_file",
  "read_file_range",
  "view_subdirectory",
]);
const WRITE_TOOLS = new Set(["write", "create_new_file"]);
const EDIT_TOOLS = new Set([
  "edit",
  "single_find_and_replace",
  "multiedit",
  "multi_edit",
]);
/** The IDE's edit tool sends an instruction, not a replacement */
const BLIND_EDIT_TOOLS = new Set(["edit_existing_file"]);

/** The path argument of a call, whatever the tool names it. */
function pathOf(args: Record<string, unknown>): string | undefined {
  for (const k of ["file_path", "filepath", "path", "file", "filename"]) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** FNV-1a, 32 bits: a content fingerprint, not a security hash. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Whether a result text reads as a failure (for hosts that do not flag it). */
export function looksLikeError(text: string): boolean {
  return /^\s*(error\b|command failed|exit code [1-9]|exited with (?:code )?[1-9]|traceback \(most recent)/i.test(
    text,
  );
}

/**
 * Keeps, across the calls of one history, what an adapter needs to say what
 * an edit changed: the virtual content of each file it edited.
 */
class FileTracker {
  private virtual = new Map<string, string>();

  private apply(
    path: string,
    oldText: string,
    newText: string,
    all: boolean,
    out: Array<{ path: string; hash: string }>,
  ): void {
    let cur = this.virtual.get(path);
    if (cur === undefined) {
      // The file as far as we know it: the text the first edit replaced
      cur = oldText;
      out.push({ path, hash: hashText(cur) });
    }
    cur = all
      ? cur.split(oldText).join(newText)
      : cur.replace(oldText, newText);
    this.virtual.set(path, cur);
    out.push({ path, hash: hashText(cur) });
  }

  changes(
    tool: string,
    args: Record<string, unknown>,
  ): Array<{ path: string; hash: string }> {
    const path = pathOf(args);
    if (!path) return [];
    const name = tool.toLowerCase();
    const out: Array<{ path: string; hash: string }> = [];
    if (WRITE_TOOLS.has(name)) {
      const content = args.content ?? args.contents;
      if (typeof content === "string") {
        this.virtual.set(path, content);
        out.push({ path, hash: hashText(content) });
      }
    } else if (EDIT_TOOLS.has(name)) {
      const edits = Array.isArray(args.edits) ? args.edits : [args];
      for (const e of edits as Array<Record<string, unknown>>) {
        const oldText = e?.old_string ?? e?.oldString ?? e?.old_str;
        const newText = e?.new_string ?? e?.newString ?? e?.new_str;
        if (typeof oldText === "string" && typeof newText === "string") {
          this.apply(path, oldText, newText, e.replace_all === true, out);
        }
      }
    } else if (BLIND_EDIT_TOOLS.has(name)) {
      const changes = args.changes;
      if (typeof changes === "string") {
        // No before and after: each distinct instruction is a distinct state
        out.push({ path, hash: hashText(`${path}\n${changes}`) });
      }
    }
    return out;
  }
}

const SHELL_TOOLS = new Set([
  "run_terminal_command",
  "bash",
  "shell",
  "powershell",
  "terminal",
]);

/** Commands that write: redirects, the shells' write verbs, git operations that change the tree. */
const SHELL_WRITE =
  /(?:^|[\s;|&(])(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|rm|mv|cp|mkdir|touch|tee|sed\s+-i|git\s+(?:apply|checkout|restore|add|commit|mv|rm|stash)|npm\s+(?:install|i)|pip\s+install)\b|>>?\s*[^\s&>|]/i;

/**
 * Whether a shell command writes to disk, by its text. A heuristic, and the
 * reason is that a script written and run through the shell is otherwise
 * invisible to "since the last file change". Redirects to the null device
 * are not writes.
 */
export function shellWrites(command: string): boolean {
  const text = command.replace(/\d?>>?\s*(?:\$null|\/dev\/null|nul)\b/gi, " ");
  return SHELL_WRITE.test(text);
}

function readsOf(tool: string, args: Record<string, unknown>): string[] {
  if (!READ_TOOLS.has(tool.toLowerCase())) return [];
  const p = pathOf(args);
  return p ? [p] : [];
}

function parseArgs(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function assistantText(item: ChatHistoryItem): string {
  return item.message.role === "assistant"
    ? renderChatMessage(item.message).trim()
    : "";
}

function makeCall(
  tracker: FileTracker,
  tool: string,
  args: Record<string, unknown>,
  result: string,
  failed: boolean,
): StuckCall {
  const call: StuckCall = { tool, args, result, error: failed };
  let changed = failed ? [] : tracker.changes(tool, args);
  const command = args.command ?? args.cmd;
  if (
    !failed &&
    changed.length === 0 &&
    SHELL_TOOLS.has(tool.toLowerCase()) &&
    typeof command === "string" &&
    shellWrites(command)
  ) {
    // The file is unknown; the command and its output stand for the new state
    changed = [{ path: "(shell)", hash: hashText(`${command} :: ${result}`) }];
  }
  if (changed.length > 0) call.changed = changed;
  const read = failed ? [] : readsOf(tool, args);
  if (read.length > 0) call.read = read;
  return call;
}

/**
 * The CLI's history: assistant messages with `toolCalls`, results in the
 * `role: "tool"` items that follow. A call with no result in the history (the
 * run ended or was cut off mid-call) is dropped from its step, not guessed.
 */
export function stepsFromCliHistory(history: ChatHistoryItem[]): StuckStep[] {
  const results = new Map<string, string>();
  for (const item of history) {
    if (item.message.role === "tool") {
      results.set(item.message.toolCallId, renderChatMessage(item.message));
    }
  }
  const tracker = new FileTracker();
  const steps: StuckStep[] = [];
  for (const item of history) {
    if (item.message.role !== "assistant") continue;
    const calls: StuckCall[] = [];
    for (const tc of item.message.toolCalls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      const result = tc.id ? results.get(tc.id) : undefined;
      if (result === undefined) continue;
      calls.push(
        makeCall(
          tracker,
          name,
          parseArgs(tc.function?.arguments),
          result,
          looksLikeError(result),
        ),
      );
    }
    const text = assistantText(item);
    if (calls.length > 0 || text) steps.push({ text, calls });
  }
  return steps;
}

function outputText(state: ToolCallState): string {
  return (state.output ?? [])
    .map((o) => o.content ?? "")
    .join("\n")
    .trim();
}

/**
 * The IDE's history: assistant items carrying `toolCallStates`. Calls that
 * never finished (`generating`, `generated`, `calling`, `canceled`) did not
 * answer, so they are left out, as the CLI adapter leaves out an unanswered
 * call.
 */
export function stepsFromGuiHistory(history: ChatHistoryItem[]): StuckStep[] {
  const tracker = new FileTracker();
  const steps: StuckStep[] = [];
  for (const item of history) {
    if (item.message.role !== "assistant") continue;
    const calls: StuckCall[] = [];
    for (const state of item.toolCallStates ?? []) {
      if (state.status !== "done" && state.status !== "errored") continue;
      const name = state.toolCall?.function?.name;
      if (!name) continue;
      const args =
        state.parsedArgs && typeof state.parsedArgs === "object"
          ? (state.parsedArgs as Record<string, unknown>)
          : parseArgs(state.toolCall?.function?.arguments);
      calls.push(
        makeCall(
          tracker,
          name,
          args,
          outputText(state),
          state.status === "errored",
        ),
      );
    }
    const text = assistantText(item);
    if (calls.length > 0 || text) steps.push({ text, calls });
  }
  return steps;
}

export type HistoryHost = "cli" | "gui";

/** Which host recorded the history: `toolCallStates` anywhere means the IDE. */
export function detectHost(history: ChatHistoryItem[]): HistoryHost {
  return history.some((h) => (h.toolCallStates?.length ?? 0) > 0)
    ? "gui"
    : "cli";
}

/** Steps from a history of either host. */
export function stepsFromHistory(history: ChatHistoryItem[]): StuckStep[] {
  return detectHost(history) === "gui"
    ? stepsFromGuiHistory(history)
    : stepsFromCliHistory(history);
}

/**
 * The history inside a saved session file: `{ history: [...] }` (the CLI's
 * and the IDE's session files), a bare array, or a bench result that keeps it
 * under `state.history`. Returns undefined for anything else.
 */
export function historyOfSessionJson(
  json: unknown,
): ChatHistoryItem[] | undefined {
  const find = (v: unknown): ChatHistoryItem[] | undefined => {
    if (Array.isArray(v)) return v as ChatHistoryItem[];
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.history)) return o.history as ChatHistoryItem[];
      if (o.state) return find(o.state);
    }
    return undefined;
  };
  const h = find(json);
  return h?.every((i) => i && typeof i === "object" && "message" in i)
    ? h
    : undefined;
}

/**
 * A history cut into the stretches after each person's message: the scope
 * OpenHands gives its stuck detector, and the right one for a loop session,
 * which receives one user message per item and per answered question. Items
 * before the first user message (a system preamble) join the first stretch.
 */
export function segmentAtUserMessages(
  history: ChatHistoryItem[],
): ChatHistoryItem[][] {
  const out: ChatHistoryItem[][] = [];
  for (const item of history) {
    if (item.message.role === "user" || out.length === 0) out.push([item]);
    else out[out.length - 1].push(item);
  }
  return out;
}
