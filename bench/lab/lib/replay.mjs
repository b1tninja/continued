// The request-dump replayer. Reads recorded request bodies (OpenAI-style
// chat requests: `messages`, optional `tools`, optional top-level `system`),
// groups them into ordered sequences and sends them through the same path as
// the cache suite, so each request gets the engine's own cached and
// evaluated token counters.
//
// Input forms (a directory or a file):
//   DIR/request-001.json ...          one sequence, files in name order
//   DIR/<set>/request-001.json ...    one sequence per sub-directory
//   FILE.jsonl                        one request per line, in order; a line is
//                                     a request body, or {"request": body}
//                                     (the segment-dump shape: extra fields
//                                     such as first_changed_vs_prev are kept in
//                                     the record's `source`, the lab computes
//                                     its own character offset as well)
// Nothing here decides what the dumps mean: it replays what was captured.
import fs from "node:fs";
import path from "node:path";
import { LabError } from "./ollama.mjs";

const byName = (a, b) => a.localeCompare(b, "en", { numeric: true });

/** Normalise one dump body to { messages, tools } in the lab's shapes. */
export function normaliseRequest(body, where = "request") {
  const raw = body?.request && !body.messages ? body.request : body;
  if (!raw || !Array.isArray(raw.messages))
    throw new LabError("refused", `${where}: no messages array`);
  const messages = [];
  if (typeof raw.system === "string" && raw.system)
    messages.push({ role: "system", content: raw.system });
  for (const m of raw.messages) messages.push({ ...m });
  const tools = (raw.tools ?? []).map((t) => {
    const f = t.function ?? t;
    return {
      name: f.name,
      description: f.description ?? "",
      parameters: f.parameters ??
        f.input_schema ?? {
          type: "object",
          properties: {},
        },
    };
  });
  return { messages, tools };
}

/** Index of the first character where two strings differ (length when one is a prefix). */
export function firstChanged(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const flat = (r) => JSON.stringify([r.tools, r.messages]);

/** Sets: [{ id, requests: [{ label, messages, tools, source? }] }]. */
export function loadDumps(target) {
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) throw new LabError("refused", `no such dump path: ${target}`);
  const sets = [];
  const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  if (st.isFile()) {
    const lines = fs
      .readFileSync(target, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const requests = lines.map((l, i) => {
      const body = JSON.parse(l);
      const src = body.request && !body.messages ? { ...body } : undefined;
      if (src) delete src.request;
      return {
        label: `line-${i + 1}`,
        ...normaliseRequest(body, `${target}:${i + 1}`),
        source: src,
      };
    });
    return [{ id: path.basename(target).replace(/\.jsonl?$/, ""), requests }];
  }
  const files = (d) =>
    fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort(byName);
  const load = (d) =>
    files(d).map((f) => ({
      label: f.replace(/\.json$/, ""),
      ...normaliseRequest(readJson(path.join(d, f)), path.join(d, f)),
    }));
  const direct = files(target);
  if (direct.length)
    sets.push({ id: path.basename(target), requests: load(target) });
  for (const e of fs
    .readdirSync(target, { withFileTypes: true })
    .sort((a, b) => byName(a.name, b.name)))
    if (e.isDirectory() && files(path.join(target, e.name)).length)
      sets.push({ id: e.name, requests: load(path.join(target, e.name)) });
  if (!sets.length)
    throw new LabError("refused", `no request-*.json files under ${target}`);
  return sets;
}

/**
 * Sequences for runCache. `nonce` is put in front of the FIRST system message
 * (or added as one) of every request, the same text in a whole run, so a
 * rerun does not meet the previous run's warm cache and the reuse between
 * the requests of one set is untouched.
 */
export function replaySequences(sets, { nonce, api }) {
  return sets.map((set) => ({
    id: set.id,
    arm: "default",
    steps: set.requests.map((r, i) => {
      const head = `[replay ${nonce}]`;
      const messages = r.messages.map((m) => ({ ...m }));
      const si = messages.findIndex((m) => m.role === "system");
      if (si >= 0)
        messages[si].content = `${head}\n${messages[si].content ?? ""}`;
      else messages.unshift({ role: "system", content: head });
      const prev = i ? set.requests[i - 1] : undefined;
      return {
        label: r.label,
        messages: messagesForApi(messages, api),
        tools: r.tools,
        source: r.source,
        firstChanged: prev ? firstChanged(flat(prev), flat(r)) : undefined,
      };
    }),
  }));
}

export const replayRequestCount = (sets) =>
  sets.reduce((n, s) => n + s.requests.length, 0);

/**
 * Ollama wants tool-call arguments as objects, the OpenAI shape has a JSON
 * string. Convert for the Ollama chat surface; leave the rest untouched.
 */
export function messagesForApi(messages, api) {
  if (api !== "ollama-chat") return messages;
  return messages.map((m) =>
    m.tool_calls
      ? {
          ...m,
          tool_calls: m.tool_calls.map((c) => {
            const a = c.function?.arguments;
            if (typeof a !== "string") return c;
            try {
              return {
                ...c,
                function: { ...c.function, arguments: JSON.parse(a) },
              };
            } catch {
              return c;
            }
          }),
        }
      : m,
  );
}
