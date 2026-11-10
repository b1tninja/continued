// Shared by runner.mjs and score.mjs: where things are, how a scenario file
// and the model matrix are read, how a serve history is picked apart, and
// how a run is priced. Plain Node, no dependencies beyond the repository's
// root node_modules (yaml).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import YAML from "yaml";

export const BENCH_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const REPO_ROOT = path.resolve(BENCH_ROOT, "..");
export const SCENARIOS_DIR = path.join(BENCH_ROOT, "scenarios");
export const MATRIX_FILE = path.join(BENCH_ROOT, "matrix.yaml");

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

/** A file-system safe name for a model id or scenario. */
export const slug = (s) =>
  String(s)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

// ---------------------------------------------------------------------------
// Scenarios

export function listScenarios() {
  return fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Reads one scenario file and checks the fields the runner and scorer rely
 * on. Throws with the file name on anything missing.
 */
export function loadScenario(name) {
  const file = path.join(SCENARIOS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No scenario ${name} (${file})`);
  const s = readJson(file);
  const problems = [];
  if (s.name !== name)
    problems.push(`name is ${JSON.stringify(s.name)}, file is ${name}`);
  for (const key of ["group", "kind", "prompt", "expectations", "budget"]) {
    if (s[key] === undefined) problems.push(`missing ${key}`);
  }
  if (!["guidance", "compliance", "safety"].includes(s.group))
    problems.push(`group ${s.group}`);
  if (!["plan", "agent", "loop"].includes(s.kind))
    problems.push(`kind ${s.kind}`);
  if (!Array.isArray(s.expectations) || !s.expectations.length)
    problems.push("expectations empty");
  for (const [i, e] of (s.expectations ?? []).entries()) {
    if (!e.check) problems.push(`expectation ${i} has no check`);
  }
  const b = s.budget ?? {};
  for (const key of ["maxRequests", "maxTokens", "deadlineSeconds"]) {
    if (typeof b[key] !== "number") problems.push(`budget.${key}`);
  }
  if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
  s.surface ??= "serve";
  s.policy ??= {};
  s.config ??= {};
  s.seed ??= { from: "seed/loopsbx" };
  return s;
}

// ---------------------------------------------------------------------------
// Matrix

export function loadMatrix(file = MATRIX_FILE) {
  const m = YAML.parse(fs.readFileSync(file, "utf-8"));
  if (!Array.isArray(m.models))
    throw new Error(`${file}: models must be a list`);
  return m;
}

/** A row by its short id or by its model id. */
export function findModelRow(matrix, idOrModel) {
  const row = matrix.models.find(
    (r) => r.id === idOrModel || r.model === idOrModel,
  );
  if (!row) {
    const ids = matrix.models.map((r) => r.id).join(", ");
    throw new Error(`No matrix row ${idOrModel}. Rows: ${ids}`);
  }
  const provider = matrix.providers?.[row.provider] ?? {};
  return { ...row, providerDefaults: provider };
}

// ---------------------------------------------------------------------------
// History

export function toolCalls(history) {
  return (history ?? []).flatMap((item) => item.toolCallStates ?? []);
}

export function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("");
  return "";
}

/** A tool call's arguments as an object, or the raw string when not JSON. */
export function argsOf(tc) {
  if (tc.parsedArgs && typeof tc.parsedArgs === "object") return tc.parsedArgs;
  const raw = tc.toolCall?.function?.arguments;
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/** A tool call's result as text. */
export function outputOf(tc) {
  const o = tc.output;
  if (typeof o === "string") return o;
  if (Array.isArray(o))
    return o
      .map((p) => (typeof p === "string" ? p : (p?.content ?? "")))
      .join("");
  return o ? JSON.stringify(o) : "";
}

export function nameOf(tc) {
  return tc.toolCall?.function?.name ?? "?";
}

/** Calls by tool name and status. */
export function tally(history) {
  const byName = {};
  for (const tc of toolCalls(history)) {
    const name = nameOf(tc);
    byName[name] ??= {};
    byName[name][tc.status] = (byName[name][tc.status] ?? 0) + 1;
  }
  return byName;
}

/**
 * Tool names a model may write as a Python call: the CLI's own, their
 * snake_case forms (Nova 2 Lite wrote `present_plan(...)` for `PresentPlan`,
 * plans/ROADMAP.md H13) and the IDE's.
 */
const PYTHON_CALL_NAMES = [
  "Write",
  "Read",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "PresentPlan",
  "FinishItem",
  "present_plan",
  "finish_item",
  "read_file",
  "write_file",
  "create_new_file",
  "edit_existing_file",
  "run_terminal_command",
  "grep_search",
];

/** `Name(key=` at the start of a line: a call with keyword arguments. */
const PYTHON_CALL = new RegExp(
  String.raw`^(?:${PYTHON_CALL_NAMES.join("|")})\(\s*[A-Za-z_][A-Za-z0-9_]*\s*=`,
  "m",
);

/**
 * Whether a reply wrote a tool call as text: Qwen's `<tool_call>` and
 * `<function=` markup, JSON naming a tool, or a Python-syntax call at the
 * start of a line. A Python call inside a code fence is an example, not a
 * leak.
 */
export function isTextLeak(text) {
  if (
    /<tool_?call|<function=|"name"\s*:\s*"(Write|Read|PresentPlan|FinishItem)"/.test(
      text,
    )
  ) {
    return true;
  }
  return PYTHON_CALL.test(text.replace(/```[\s\S]*?(```|$)/g, ""));
}

/** Assistant replies that wrote a tool call as text instead of making it. */
export function textLeaks(history) {
  return (history ?? [])
    .filter((i) => i.message?.role === "assistant")
    .map((i) => textOf(i.message))
    .filter(isTextLeak)
    .map((t) => t.slice(0, 200));
}

/** The harness's own nudges, recognised by their wording (core/util/turnEnd.ts). */
const CLI_NUDGES = [
  [/^You named the next step and then stopped/, "act"],
  [/^You ended without reporting/, "finishItem"],
  [
    /^You ended without presenting the plan|^Call the PresentPlan tool now/,
    "presentPlan",
  ],
];

export function cliNudges(history) {
  const out = { act: 0, finishItem: 0, presentPlan: 0 };
  for (const item of history ?? []) {
    if (item.message?.role !== "user") continue;
    const t = textOf(item.message);
    for (const [re, k] of CLI_NUDGES) if (re.test(t)) out[k]++;
  }
  return out;
}

/** The provider's usage for one assistant message, normalised to one shape. */
export function usageOfMessage(message) {
  const u = message?.usage ?? {};
  const d = u.prompt_tokens_details ?? u.promptTokensDetails ?? {};
  return {
    prompt: u.prompt_tokens ?? u.promptTokens ?? 0,
    completion: u.completion_tokens ?? u.completionTokens ?? 0,
    cacheRead: d.cache_read_tokens || d.cached_tokens || d.cachedTokens || 0,
    cacheWrite: d.cache_write_tokens || d.cacheWriteTokens || 0,
  };
}

/** One entry per model request: tokens, cache, the tool calls it made. */
export function turnsOf(history, maxTokens) {
  const out = [];
  for (const item of history ?? []) {
    if (item.message?.role !== "assistant") continue;
    const u = usageOfMessage(item.message);
    const calls = item.toolCallStates ?? [];
    out.push({
      ...u,
      tools: calls.map((tc) => `${nameOf(tc)}:${tc.status}`),
      textChars: textOf(item.message).length,
      atCap: typeof maxTokens === "number" && u.completion >= maxTokens - 2,
    });
  }
  return out;
}

/** What the act turn is measured on: did it act, and how did it end? */
export function agentShape(history) {
  const assistant = (history ?? []).filter(
    (i) => i.message?.role === "assistant",
  );
  const last = assistant.at(-1);
  const lastText = textOf(last?.message).trim();
  return {
    assistantTurns: assistant.length,
    turnsWithoutTools: assistant.filter((i) => !(i.toolCallStates ?? []).length)
      .length,
    endsWithoutTools: !!last && !(last.toolCallStates ?? []).length,
    asksToProceed:
      /should I|would you like me|do you want me|let me know if|shall I/i.test(
        lastText,
      ),
    mentionsCouldNot:
      /could not|couldn't|was not able|unable to|refused|blocked|not run|denied/i.test(
        lastText,
      ),
    finalText: lastText.slice(0, 1500),
  };
}

/** The last assistant reply's text (the report, when the run ended in text). */
export function finalText(history) {
  const assistant = (history ?? []).filter(
    (i) => i.message?.role === "assistant",
  );
  return textOf(assistant.at(-1)?.message).trim();
}

// ---------------------------------------------------------------------------
// Pricing

/**
 * USD per million tokens from the matrix row, or null when the row has no
 * price. `cacheRead` defaults to the input price (no discount known).
 */
export function priceOf(row) {
  const p = row?.price;
  if (!p || typeof p.input !== "number" || typeof p.output !== "number")
    return null;
  return {
    input: p.input,
    output: p.output,
    cacheRead: typeof p.cacheRead === "number" ? p.cacheRead : p.input,
    cacheWrite: typeof p.cacheWrite === "number" ? p.cacheWrite : p.input,
    source: p.source ?? "matrix",
  };
}

/** The CLI's fallback rate for a model with no price table entry (streamChatResponse.helpers.ts). */
export const CLI_FALLBACK_PRICE = {
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

/**
 * The run's cost at list price (null when the row has no price), what the CLI
 * reported, and whether the CLI figure was at the fallback rate. Token counts
 * are the session totals as the CLI adds them up: `promptTokens` is the
 * processed input (for Claude without the cache; for others with it), so the
 * cache part is subtracted only when it would otherwise be counted twice.
 */
export function priceRun(row, usage) {
  const u = usage ?? {};
  const read = u.promptTokensDetails?.cachedTokens ?? 0;
  const write = u.promptTokensDetails?.cacheWriteTokens ?? 0;
  const prompt = u.promptTokens ?? 0;
  const completion = u.completionTokens ?? 0;
  const excludesCache = /claude/i.test(row?.model ?? "");
  const uncached = excludesCache ? prompt : Math.max(0, prompt - read - write);
  const price = priceOf(row);
  const list = price
    ? (uncached * price.input +
        read * price.cacheRead +
        write * price.cacheWrite +
        completion * price.output) /
      1e6
    : null;
  const fallback =
    (uncached * CLI_FALLBACK_PRICE.input +
      read * CLI_FALLBACK_PRICE.cacheRead +
      write * CLI_FALLBACK_PRICE.cacheWrite +
      completion * CLI_FALLBACK_PRICE.output) /
    1e6;
  const cli = typeof u.totalCost === "number" ? u.totalCost : null;
  // "estimated" when no list price is known for the row; `cliFallback` when
  // the CLI's own figure sits at its fallback rate (no price table entry).
  const estimated = list === null;
  const cliFallback =
    cli !== null &&
    Math.abs(cli - fallback) < Math.max(1e-6, fallback * 0.02) &&
    !(list !== null && Math.abs(cli - list) < Math.max(1e-6, list * 0.02));
  return {
    list,
    cli,
    estimated,
    cliFallback,
    tokens: { in: prompt, out: completion, cacheRead: read, cacheWrite: write },
    cacheReadRatio:
      prompt + (excludesCache ? read + write : 0) > 0
        ? read / (prompt + (excludesCache ? read + write : 0))
        : 0,
  };
}

export const money = (v) =>
  v === null || v === undefined ? "n/a" : `$${v.toFixed(v < 0.1 ? 4 : 3)}`;

// ---------------------------------------------------------------------------
// From a /state snapshot to the result fields

/**
 * Fills a run result from the serve's final /state: turns, nudges, tool
 * tallies, loop and plan summaries, usage and cost. Shared by the runner and
 * by anything that imports an older results folder.
 */
export function fillFromState(result, s, row) {
  const history = s.session?.history ?? [];
  result.nudges ??= {
    harness: 0,
    cli: { act: 0, finishItem: 0, presentPlan: 0 },
  };
  result.questions ??= [];
  result.settings ??= {};
  result.turns = history.filter((i) => i.message?.role === "assistant").length;
  result.nudges.cli = cliNudges(history);
  result.tools = tally(history);
  result.textLeaks = textLeaks(history);
  result.perTurn = turnsOf(history, result.settings.maxTokens);
  result.truncations =
    s.truncatedReplies ?? result.perTurn.filter((t) => t.atCap).length;
  result.repeatsRefused = toolCalls(history).filter((tc) =>
    /was not run: (it is identical|this call already failed)|round in a row of tool calls with invalid/.test(
      outputOf(tc),
    ),
  ).length;
  result.invalidCalls = toolCalls(history).filter(
    (tc) =>
      tc.status === "errored" &&
      /required|invalid|unknown tool|not a valid|must be|JSON/i.test(
        outputOf(tc),
      ),
  ).length;
  result.promptCache = s.promptCache ?? null;
  result.pendingQuestions = s.pendingQuestions ?? [];
  for (const q of result.pendingQuestions) {
    result.questions.push({
      id: q.id,
      kind: "held",
      type: q.type ?? null,
      question: String(q.question).slice(0, 300),
      state: q.state,
      answeredBy: q.answer ? "person" : "nobody",
    });
  }
  result.pendingPermission = s.pendingPermission
    ? { toolName: s.pendingPermission.toolName }
    : null;
  result.usage = s.session?.usage ?? null;
  result.shape = agentShape(history);
  result.finalText = finalText(history).slice(0, 3000);
  if (s.loop) {
    const l = s.loop;
    result.loop = {
      status: l.status,
      stopReason: l.stopReason ?? null,
      stopDetail: l.stopDetail ?? null,
      rounds: l.round,
      autonomy: l.autonomy,
      strategy: l.strategy,
      items: (l.items ?? []).map((i) => ({
        id: i.id,
        text: String(i.text ?? i.title ?? "").slice(0, 200),
        status: i.status,
        attempts: i.attempts,
        check: i.check?.status ?? null,
        summary: i.summary?.slice(0, 200) ?? null,
      })),
      statusLine: s.loopStatus ?? null,
    };
  }
  result.presentPlans = toolCalls(history)
    .filter((tc) => nameOf(tc) === "PresentPlan")
    .map((tc) => ({
      status: tc.status,
      args: argsOf(tc),
      output: outputOf(tc).slice(0, 500),
    }));
  const price = priceRun(row, result.usage);
  result.tokens = price.tokens;
  result.cacheReadRatio = price.cacheReadRatio;
  result.cost = {
    list: price.list,
    cli: price.cli,
    estimated: price.estimated,
    cliFallback: price.cliFallback,
  };
  result.turnError = turnErrorOf(history);
  return result;
}

/**
 * The error text when a turn failed inside the serve: serve.messages.ts
 * records it as an assistant message that starts with "Error:", so a run that
 * ends in one did not end in a report. Null when the last reply is a reply.
 */
export function turnErrorOf(history) {
  const text = finalText(history);
  return /^Error:/.test(text) ? text.slice(0, 400) : null;
}

// ---------------------------------------------------------------------------
// The tail's columns (plans/ROADMAP.md row I6): nudges by kind, requests per
// item attempt, and prefix churn from the request dumps.

/** The nudges of a run by kind: the harness's own, and the CLI's three (core/util/turnEnd.ts). */
export function nudgeKindsOf(result) {
  const cli = result?.nudges?.cli ?? {};
  return {
    harness: result?.nudges?.harness ?? 0,
    act: cli.act ?? 0,
    finishItem: cli.finishItem ?? 0,
    presentPlan: cli.presentPlan ?? 0,
  };
}

/** The Loop's item prompt opens an attempt (core/util/loopMode.ts). */
const ITEM_START = /^Work on this item of the plan/;
/** A user message that continues the attempt instead of starting a turn of its own: an answer or a nudge. */
const ITEM_CONTINUATION =
  /^The person answered|^You ended without|^You named the next step|^Call the PresentPlan tool now/;

/**
 * Requests per item attempt, from the history: an attempt starts at the
 * item prompt and takes every request up to the next user message that is
 * neither an answer nor a nudge; the rest are plan and re-plan requests.
 * `withoutFinishItem` counts the attempts the CLI nudged for FinishItem (one
 * nudge per turn, so one per such attempt). Null when the run is not a loop.
 */
export function loopStatsOf(result, history) {
  if (!result?.loop && result?.kind !== "loop") return null;
  const perAttempt = [];
  let planRequests = 0;
  let inItem = false;
  for (const item of history ?? []) {
    const role = item.message?.role;
    if (role === "user") {
      const t = textOf(item.message);
      if (ITEM_START.test(t)) {
        inItem = true;
        perAttempt.push(0);
      } else if (!ITEM_CONTINUATION.test(t)) inItem = false;
    } else if (role === "assistant") {
      if (inItem) perAttempt[perAttempt.length - 1] += 1;
      else planRequests += 1;
    }
  }
  const itemRequests = perAttempt.reduce((a, b) => a + b, 0);
  const items = result?.loop?.items ?? [];
  const itemsByStatus = {};
  for (const i of items)
    itemsByStatus[i.status] = (itemsByStatus[i.status] ?? 0) + 1;
  return {
    items: items.length,
    itemsByStatus,
    attempts: perAttempt.length,
    withoutFinishItem: result?.nudges?.cli?.finishItem ?? 0,
    planRequests,
    itemRequests,
    requestsPerAttempt: perAttempt.length
      ? itemRequests / perAttempt.length
      : null,
    perAttempt,
  };
}

/**
 * The messages of one dumped request body (CONTINUE_DUMP_REQUESTS), with a
 * `system` field of its own put first so that a provider that takes the
 * system text apart from the messages compares the same way.
 */
export function messagesOfRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return body?.system !== undefined
    ? [{ role: "system", content: body.system }, ...messages]
    : messages;
}

/**
 * Prefix churn: the requests of a run that did not extend the one before
 * them. A request extends its predecessor when it has at least as many
 * messages and each earlier message is the same JSON; otherwise the request
 * is counted, with the index of the first message that differs (the
 * predecessor's length when the request is only shorter). A prompt cache
 * matches on the longest shared prefix, so every churned request re-reads
 * the prefix from that message on. `names` labels the entries (file names).
 */
export function prefixChurn(requests, names = []) {
  const churned = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    const cur = requests[i];
    let message = null;
    for (let j = 0; j < prev.length; j++) {
      if (
        j >= cur.length ||
        JSON.stringify(cur[j]) !== JSON.stringify(prev[j])
      ) {
        message = j;
        break;
      }
    }
    if (message !== null)
      churned.push({
        request: i + 1,
        message,
        previousLength: prev.length,
        length: cur.length,
        ...(names[i] ? { file: names[i] } : {}),
      });
  }
  return {
    requests: requests.length,
    churned: churned.length,
    first: churned[0] ?? null,
    all: churned,
  };
}

/** `prefixChurn` over a run's `requests/` folder, in file order; null without dumps. */
export function prefixChurnOf(dumpsDir) {
  if (!dumpsDir || !fs.existsSync(dumpsDir)) return null;
  const files = fs
    .readdirSync(dumpsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  const requests = files.map((f) =>
    messagesOfRequest(readJson(path.join(dumpsDir, f))),
  );
  return prefixChurn(requests, files);
}
