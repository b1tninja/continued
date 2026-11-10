/**
 * The persistent side of MCP tool pinning (plans/prompt-injection.md, P2/P4).
 * toolPinning.ts is pure; this file holds what needs Node: the sha256, the
 * JSON file under the global config folder, and the fingerprint that keeps a
 * different server of the same name from inheriting an earlier approval.
 *
 * Not for the webview: it imports `crypto` and `fs`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { InternalMcpOptions } from "../..";
import { getContinueGlobalPath } from "../../util/paths";
import {
  canonicalJson,
  checkToolPins,
  hashToolDefinition,
  type McpToolDefinition,
  type PinRecord,
  type ToolPinReport,
  type ToolPinStore,
} from "./toolPinning";

export const sha256Hex = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

/** Hash of the parts of one tool, so a change can be named ("description"). */
export interface ToolParts {
  description: string;
  schema: string;
  other: string;
  descriptionLength: number;
}

export interface PersistedPin extends PinRecord {
  /** Per-field hashes, to say what changed. Absent in records from older files. */
  parts?: Record<string, ToolParts>;
}

export function toolParts(tool: McpToolDefinition): ToolParts {
  return {
    description: sha256Hex(tool.description ?? ""),
    schema: sha256Hex(
      canonicalJson([tool.inputSchema, tool.outputSchema ?? null]),
    ),
    other: sha256Hex(canonicalJson([tool.title, tool.annotations])),
    descriptionLength: (tool.description ?? "").length,
  };
}

/**
 * Identity of a server for trust purposes: its name and a hash of how it is
 * reached (command, arguments, environment, folder, URL, key). Another server
 * under the same name, or the same name pointed somewhere else, gets a new
 * key and so starts as `new`. Secrets only ever enter through the hash.
 */
export function pinKey(options: InternalMcpOptions): string {
  const o = options as Record<string, unknown>;
  const connection = sha256Hex(
    canonicalJson({
      type: o.type ?? null,
      command: o.command,
      args: o.args,
      env: o.env,
      cwd: o.cwd,
      url: o.url,
      apiKey: o.apiKey,
      configSource: o.configSource,
    }),
  );
  return `${options.name}#${connection.slice(0, 32)}`;
}

interface PinFile {
  version: 1;
  servers: Record<string, PersistedPin>;
}

export function defaultPinFilePath(globalDir: string): string {
  return path.join(globalDir, "mcp-tool-pins.json");
}

/**
 * JSON file of approvals. Writes go to a temporary file in the same folder and
 * are renamed over the target, so a crash leaves the old file or the new one.
 * A file that cannot be parsed is renamed to `<name>.corrupt-<time>` and the
 * store starts empty: every server is then `new`, which the normal approval
 * flow handles, rather than silently trusted or permanently broken.
 */
export class FileToolPinStore implements ToolPinStore {
  private cache: PinFile | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** Set when a load had to set a damaged file aside. */
  public recoveredFrom: string | undefined;

  constructor(private readonly file: string) {}

  private load(): PinFile {
    if (this.cache) return this.cache;
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") this.setAside();
    }
    let parsed: PinFile | undefined;
    if (raw !== undefined) {
      try {
        const v = JSON.parse(raw);
        if (
          v &&
          typeof v === "object" &&
          v.version === 1 &&
          v.servers &&
          typeof v.servers === "object" &&
          !Array.isArray(v.servers)
        ) {
          parsed = {
            version: 1,
            servers: Object.assign(Object.create(null), v.servers),
          };
        }
      } catch {
        // falls through to the backup below
      }
      if (!parsed) this.setAside();
    }
    this.cache = parsed ?? { version: 1, servers: Object.create(null) };
    return this.cache;
  }

  private setAside(): void {
    const backup = `${this.file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      this.recoveredFrom = backup;
    } catch {
      // Nothing to set aside, or it cannot be moved: start empty either way.
    }
  }

  async get(key: string): Promise<PersistedPin | undefined> {
    return this.load().servers[key];
  }

  async set(record: PersistedPin): Promise<void> {
    const data = this.load();
    data.servers[record.serverId] = record;
    const text = JSON.stringify(data, null, 2);
    const run = async () => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // best effort
        }
        throw e;
      }
    };
    // One write at a time, in call order; a failure does not block the next.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    await next;
  }
}

/** What the person is told: the changed tools and what part of each. */
export function summarizeToolChanges(
  report: ToolPinReport,
  tools: McpToolDefinition[],
  pinned: PersistedPin | undefined,
): string {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const parts: string[] = [];
  for (const c of report.changed) {
    const tool = byName.get(c.name);
    const before = pinned?.parts?.[c.name];
    const what: string[] = [];
    if (tool && before) {
      const now = toolParts(tool);
      if (now.description !== before.description) {
        what.push(
          `description ${before.descriptionLength} to ${now.descriptionLength} characters`,
        );
      }
      if (now.schema !== before.schema) what.push("parameters");
      if (now.other !== before.other) what.push("title or annotations");
    }
    parts.push(`${c.name} (${what.join(", ") || "definition"})`);
  }
  const out: string[] = [];
  if (parts.length) out.push(`changed: ${parts.join("; ")}`);
  if (report.added.length) out.push(`added: ${report.added.join(", ")}`);
  if (report.removed.length) out.push(`removed: ${report.removed.join(", ")}`);
  return out.join(". ");
}

export interface PinEvaluation {
  report: ToolPinReport;
  /** Tools that must ask again (changed or added since approval). Empty for new/unchanged. */
  flagged: Map<string, { kind: "changed" | "added"; summary: string }>;
}

/** Check a server's tools against the store and say which tools must ask. */
export async function evaluatePins(
  key: string,
  tools: McpToolDefinition[],
  store: ToolPinStore,
): Promise<PinEvaluation> {
  const report = await checkToolPins(key, tools, store, sha256Hex);
  const flagged: PinEvaluation["flagged"] = new Map();
  if (report.status === "changed") {
    const summary = summarizeToolChanges(
      report,
      tools,
      (await store.get(key)) as PersistedPin | undefined,
    );
    for (const c of report.changed) {
      flagged.set(c.name, { kind: "changed", summary });
    }
    for (const n of report.added) flagged.set(n, { kind: "added", summary });
  }
  return { report, flagged };
}

/**
 * Record an approval. A `new` server is pinned as a whole on its first
 * successful use. A `changed` server only has the named tool re-pinned (and
 * removed tools dropped), so approving one call does not silently accept the
 * other tools that also changed. Returns whether the pin file changed.
 */
export async function recordApproval(
  key: string,
  tools: McpToolDefinition[],
  store: ToolPinStore,
  toolName: string,
  now: Date = new Date(),
): Promise<boolean> {
  const existing = (await store.get(key)) as PersistedPin | undefined;
  const current = tools.find((t) => t.name === toolName);
  if (!current) return false;
  if (!existing) {
    const all: PersistedPin = {
      serverId: key,
      tools: {},
      parts: {},
      approvedAt: now.toISOString(),
    };
    for (const t of tools) {
      all.tools[t.name] = hashToolDefinition(t, sha256Hex);
      all.parts![t.name] = toolParts(t);
    }
    await store.set(all);
    return true;
  }
  const h = hashToolDefinition(current, sha256Hex);
  if (existing.tools[toolName] === h) return false;
  const live = new Set(tools.map((t) => t.name));
  const next: PersistedPin = {
    ...existing,
    tools: { ...existing.tools, [toolName]: h },
    parts: { ...(existing.parts ?? {}), [toolName]: toolParts(current) },
    approvedAt: now.toISOString(),
  };
  for (const n of Object.keys(next.tools)) {
    if (!live.has(n)) {
      delete next.tools[n];
      delete next.parts![n];
    }
  }
  await store.set(next);
  return true;
}

let defaultStore: ToolPinStore | undefined;

/** The store MCPConnection uses unless a test replaces it. */
export function getToolPinStore(): ToolPinStore {
  defaultStore ??= new FileToolPinStore(
    defaultPinFilePath(getContinueGlobalPath()),
  );
  return defaultStore;
}

export function setToolPinStore(store: ToolPinStore | undefined): void {
  defaultStore = store;
}
