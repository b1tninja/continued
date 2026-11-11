/**
 * `continuous agents list [--json]`: what `cn serve` says its agents are
 * (GET /agents, the agent map's allow-listed list). It reads from a running
 * server; a process that is not serving has no agents of its own to show.
 * The text is cleaned of control characters, because the server may not be
 * this machine's.
 */

import type { AgentView, AgentsSnapshot } from "core/agents/project.js";

import { tokenForUrl } from "./serve.auth.js";
import { DEFAULT_SERVE_HOST } from "./serve.helpers.js";

export interface AgentsCommandOptions {
  json?: boolean;
  /** The server's address; defaults to the local `cn serve` port */
  url?: string;
  token?: string;
}

export interface AgentsCommandDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const DEFAULT_URL = `http://${DEFAULT_SERVE_HOST}:8000`;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v: unknown): string => String(v ?? "").replace(CONTROL, " ");

function money(v: number | "unknown" | undefined): string {
  if (v === undefined || v === "unknown") return "unknown";
  return `$${v.toFixed(v < 0.01 && v > 0 ? 4 : 2)}`;
}

function elapsed(n: AgentView, now: number): string {
  if (n.startedAt === undefined) return "-";
  const s = Math.max(0, Math.round(((n.endedAt ?? now) - n.startedAt) / 1000));
  return s >= 60
    ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
    : `${s}s`;
}

function depthOf(n: AgentView, byId: Map<string, AgentView>): number {
  let depth = 0;
  for (
    let cur = n;
    cur.parentId && byId.has(cur.parentId) && depth < 20;
    cur = byId.get(cur.parentId)!
  ) {
    depth++;
  }
  return depth;
}

/** The snapshot as lines of text, one agent per line, children indented. */
export function formatAgents(snapshot: AgentsSnapshot): string[] {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  if (snapshot.error) return [clean(snapshot.error)];
  if (nodes.length === 0) return ["No agents."];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const now = snapshot.generatedAt ?? Date.now();
  const rows = nodes.map((n) => {
    const name = `${"  ".repeat(depthOf(n, byId))}${clean(n.role)}`;
    const doing = n.blockedOn
      ? `waiting: ${clean(n.blockedOn)}`
      : clean(n.activity ?? "");
    return [
      name,
      clean(n.kind),
      clean(n.state),
      clean(n.model ?? ""),
      doing,
      elapsed(n, now),
      money(n.cost?.subtree),
    ];
  });
  const head = ["AGENT", "KIND", "STATE", "MODEL", "DOING", "TIME", "COST"];
  const width = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(width[i]))
      .join("  ")
      .trimEnd();
  const out = [line(head), ...rows.map(line)];
  if (snapshot.needsYou?.length) {
    out.push("", `${snapshot.needsYou.length} waiting for you`);
  }
  return out;
}

/** Returns the exit code. */
export async function agentsCommand(
  action: string | undefined,
  options: AgentsCommandOptions,
  deps: AgentsCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  if (action !== undefined && action !== "list") {
    err(`Unknown action '${clean(action)}'. Use: agents list [--json]`);
    return 1;
  }
  const base = (options.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const token =
    options.token ?? env.CONTINUOUS_SERVE_TOKEN ?? tokenForUrl(base);
  let snapshot: AgentsSnapshot;
  try {
    const res = await (deps.fetch ?? fetch)(`${base}/agents`, {
      headers: token ? { authorization: `Bearer ${token.trim()}` } : {},
    });
    if (!res.ok) {
      err(
        res.status === 401
          ? "The server needs a bearer token: pass --token or set CONTINUOUS_SERVE_TOKEN."
          : `The server answered ${res.status}.`,
      );
      return 1;
    }
    snapshot = (await res.json()) as AgentsSnapshot;
  } catch {
    err(
      `Could not reach a cn serve at ${clean(base)}. Start one, or pass --url.`,
    );
    return 1;
  }
  if (options.json) out(JSON.stringify(snapshot, null, 2));
  else formatAgents(snapshot).forEach((l) => out(l));
  return 0;
}
