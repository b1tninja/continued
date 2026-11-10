/**
 * MCP tool-definition pinning (plans/prompt-injection.md, section 5): hash
 * what each server tells the model about its tools, and notice when it changes
 * after the user approved it. This is the "rug pull" check: a server that
 * shows a harmless description at approval and a poisoned one later. It
 * cannot see a change in what the server does, only in what it says it does;
 * it also cannot tell a poisoned first description from an honest one, which
 * is what `suspiciousToolDefinitions` is for, and that is a hint.
 *
 * Pure functions plus a store interface. Not wired into MCPConnection. The
 * hash function is passed in so this file imports nothing from Node and the
 * webview may import it.
 */
import { detectInstructionLikeText } from "../../tools/permissions/injection";

/** The parts of an MCP tool the model reads. Extra fields are ignored. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export type HashFn = (canonicalJson: string) => string;

export interface PinRecord {
  serverId: string;
  /** Tool name to hash of its canonical definition. */
  tools: Record<string, string>;
  approvedAt: string;
}

export interface ToolPinStore {
  get(serverId: string): Promise<PinRecord | undefined>;
  set(record: PinRecord): Promise<void>;
}

export interface ToolChange {
  name: string;
  before: string;
  after: string;
}

export interface ToolPinReport {
  serverId: string;
  /**
   * "new": no approval recorded for this server, the UI should ask.
   * "changed": approved before, and a definition changed, appeared or
   * disappeared, the UI should ask again.
   * "unchanged": identical to what was approved.
   */
  status: "new" | "changed" | "unchanged";
  /** Hash differs from the approved one. The case a rug pull produces. */
  changed: ToolChange[];
  added: string[];
  removed: string[];
}

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Hash of everything the model reads about one tool. The strings are hashed
 * exactly as sent: no Unicode normalisation, so a change that only adds an
 * invisible character still counts.
 */
export function hashToolDefinition(
  tool: McpToolDefinition,
  hash: HashFn,
): string {
  return hash(
    canonicalJson({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  );
}

function hashAll(
  tools: McpToolDefinition[],
  hash: HashFn,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const t of tools) {
    // Two tools of one name from one server: keep both visible by hashing the
    // pair, so a duplicate appearing later reads as a change.
    out[t.name] =
      t.name in out
        ? hash(out[t.name] + hashToolDefinition(t, hash))
        : hashToolDefinition(t, hash);
  }
  return out;
}

/** Compare a server's current tool list with what was approved. Writes nothing. */
export async function checkToolPins(
  serverId: string,
  tools: McpToolDefinition[],
  store: ToolPinStore,
  hash: HashFn,
): Promise<ToolPinReport> {
  const now = hashAll(tools, hash);
  const pinned = await store.get(serverId);
  if (!pinned) {
    return {
      serverId,
      status: "new",
      changed: [],
      added: Object.keys(now).sort(),
      removed: [],
    };
  }
  const changed: ToolChange[] = [];
  const added: string[] = [];
  for (const name of Object.keys(now).sort()) {
    if (!(name in pinned.tools)) added.push(name);
    else if (pinned.tools[name] !== now[name]) {
      changed.push({ name, before: pinned.tools[name], after: now[name] });
    }
  }
  const removed = Object.keys(pinned.tools)
    .filter((n) => !(n in now))
    .sort();
  const differs = changed.length + added.length + removed.length > 0;
  return {
    serverId,
    status: differs ? "changed" : "unchanged",
    changed,
    added,
    removed,
  };
}

/** Record the current tool list as approved. Call only after the user said yes. */
export async function approveToolPins(
  serverId: string,
  tools: McpToolDefinition[],
  store: ToolPinStore,
  hash: HashFn,
  now: Date = new Date(),
): Promise<void> {
  await store.set({
    serverId,
    tools: hashAll(tools, hash),
    approvedAt: now.toISOString(),
  });
}

/** In-memory store, for tests and as the shape a persistent one follows. */
export class MemoryToolPinStore implements ToolPinStore {
  private records = new Map<string, PinRecord>();
  async get(serverId: string) {
    return this.records.get(serverId);
  }
  async set(record: PinRecord) {
    this.records.set(record.serverId, record);
  }
}

export interface SuspiciousTool {
  name: string;
  /** Where in the definition the wording was found. */
  where: string;
  ids: string[];
}

function* stringsIn(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      yield* stringsIn(value[i], `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value))
      yield* stringsIn(v, `${path}.${k}`);
  }
}

/**
 * Tool definitions whose text reads like instructions to the model. Looks at
 * the description, title and every string in the schemas (tool poisoning also
 * hides in parameter descriptions, as in Invariant Labs' 2025-04 report).
 * Uses the output detector, so it shares its limits: a hint for the approval
 * dialog, not a verdict.
 */
export function suspiciousToolDefinitions(
  tools: McpToolDefinition[],
): SuspiciousTool[] {
  const out: SuspiciousTool[] = [];
  for (const t of tools) {
    const fields: [string, unknown][] = [
      ["title", t.title],
      ["description", t.description],
      ["inputSchema", t.inputSchema],
      ["outputSchema", t.outputSchema],
    ];
    for (const [label, v] of fields) {
      for (const [path, text] of stringsIn(v, label)) {
        const ids = detectInstructionLikeText(text).map((m) => m.id);
        if (ids.length) out.push({ name: t.name, where: path, ids });
      }
    }
  }
  return out;
}
