/**
 * The `toolcall-json` dialect: NVIDIA Nemotron-H / Nano v2 and Llama-3.x
 * Nemotron write a call as a JSON array inside `<TOOLCALL>` tags,
 *
 *   <TOOLCALL>[{"name": "get_weather", "arguments": {"city": "Paris"}}]</TOOLCALL>
 *
 * Source: the model chat templates (Nano-9B-v2 tokenizer_config.json, read
 * 2026-11-10), which instruct `<TOOLCALL>[{"name": ..., "arguments": ...}, ...]`
 * and render an assistant's calls as `<TOOLCALL>[` ... `]</TOOLCALL>`. No live
 * reply was captured; the corpus fixtures are synthesised from the template,
 * so this parser is opt-in (`toolDialect: toolcall-json`) only.
 *
 * Strict, like the other dialects, and deliberately stricter than the vendor's
 * vLLM parser, which keeps only the first `<TOOLCALL>` match, silently drops a
 * call without `arguments` (or one written with `parameters`), and "repairs"
 * a missing bracket by prepending one. Here the whole reply must be: an
 * optional leading `<think>...</think>` block (kept as text), then one or more
 * `<TOOLCALL>` blocks separated by whitespace, and nothing else. A block is a
 * non-empty JSON array of objects with exactly `name` and `arguments` (an
 * object, or a string that holds one: double encoding is repaired once). Each
 * name is a declared tool and its arguments fit the schema. If any call in any
 * block fails, the whole reply stays text (it is counted as released as text
 * in the recovery stats): a malformed call is refused, never dropped.
 */
import { fittedCall } from "./schemaCheck.js";
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const OPEN = "<TOOLCALL>";
const CLOSE = "</TOOLCALL>";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Index just past the JSON array starting at `start`, string-aware. */
function arrayEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && --depth === 0) {
      return c === "]" ? i + 1 : -1;
    }
  }
  return -1;
}

function callFrom(
  value: unknown,
  tools: DialectTool[],
  raw: string,
): RecoveredCall | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("name" in value) || !("arguments" in value)) {
    return undefined;
  }
  const tool = tools.find((t) => t.name === value.name);
  if (!tool) return undefined;
  let args = value.arguments;
  if (typeof args === "string") args = parseJson(args);
  if (!isObject(args)) return undefined;
  return fittedCall(tool, args, raw);
}

/** The calls of one block's array text, or undefined if any is refused. */
function callsOfArray(
  array: string,
  tools: DialectTool[],
  raw: string,
): RecoveredCall[] | undefined {
  const list = parseJson(array);
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const calls: RecoveredCall[] = [];
  for (const item of list) {
    const call = callFrom(item, tools, raw);
    if (!call) return undefined;
    calls.push(call);
  }
  return calls;
}

/** The calls in `text` when all of it is `<TOOLCALL>` blocks, else undefined. */
export function recoverToolcallJsonCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  let pos = lead.length;
  const calls: RecoveredCall[] = [];
  for (;;) {
    pos = skipSpace(text, pos);
    if (pos >= text.length) break;
    if (!text.startsWith(OPEN, pos)) return undefined;
    const start = skipSpace(text, pos + OPEN.length);
    if (text[start] !== "[") return undefined;
    const end = arrayEnd(text, start);
    if (end === -1) return undefined;
    const close = skipSpace(text, end);
    if (!text.startsWith(CLOSE, close)) return undefined;
    const found = callsOfArray(
      text.slice(start, end),
      tools,
      text.slice(pos, close + CLOSE.length),
    );
    if (!found) return undefined;
    calls.push(...found);
    pos = close + CLOSE.length;
  }
  return calls.length > 0 ? { lead, calls } : undefined;
}

/** Calls in the form the template renders them, for round-trip tests. */
export function renderToolcallJsonCalls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  const items = calls.map((c) =>
    JSON.stringify({ name: c.name, arguments: c.arguments }),
  );
  return `${OPEN}[${items.join(", ")}]${CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class ToolcallJsonRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, OPEN], recoverToolcallJsonCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverToolcallJsonFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new ToolcallJsonRecovery(tools), text);
}
