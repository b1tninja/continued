/**
 * The `hermes-json` dialect: Hermes-style models (Hermes 2/3, Qwen2.5, Qwen3)
 * write a call as JSON inside `<tool_call>` tags,
 *
 *   <tool_call>
 *   {"name": "get_weather", "arguments": {"city": "Paris"}}
 *   </tool_call>
 *
 * Source: the Qwen3-30B-A3B and Hermes-3 chat templates (plans/tool-dialect-
 * reference.md, "Qwen3 (non-coder) and Hermes-style"), read 2026-11-10. No live
 * capture of a leak exists; the corpus fixtures are synthesised from the
 * template, so this parser is opt-in (`toolDialect: hermes-json`) only.
 *
 * Strict, like the other dialects. The whole reply must be: an optional
 * leading `<think>...</think>` block (kept as text), then one or more
 * `<tool_call>` blocks separated by whitespace, and nothing else. A block is
 * one JSON object with exactly `name` and `arguments` (an object, or a string
 * that holds one: double encoding is repaired once). The name is a declared
 * tool and the arguments fit its schema. Anything else stays text.
 */
import { argumentsFit } from "./schemaCheck.js";
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

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

/** Index just past the JSON object starting at `start`, string-aware. */
function objectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function callFrom(
  value: unknown,
  tools: DialectTool[],
  raw: string,
): RecoveredCall | undefined {
  if (!isObject(value)) return undefined;
  if (Object.keys(value).some((k) => k !== "name" && k !== "arguments")) {
    return undefined;
  }
  const tool = tools.find((t) => t.name === value.name);
  if (!tool) return undefined;
  let args = value.arguments;
  if (typeof args === "string") args = parseJson(args);
  if (!isObject(args) || !argumentsFit(tool, args)) return undefined;
  return { name: tool.name, arguments: { ...args }, raw };
}

/** The calls in `text` when all of it is Hermes calls, else undefined. */
export function recoverHermesJsonCalls(
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
    if (text[start] !== "{") return undefined;
    const end = objectEnd(text, start);
    if (end === -1) return undefined;
    const close = skipSpace(text, end);
    if (!text.startsWith(CLOSE, close)) return undefined;
    const call = callFrom(
      parseJson(text.slice(start, end)),
      tools,
      text.slice(pos, close + CLOSE.length),
    );
    if (!call) return undefined;
    calls.push(call);
    pos = close + CLOSE.length;
  }
  return calls.length > 0 ? { lead, calls } : undefined;
}

/** A call in the form Hermes writes it, for round-trip tests. */
export function renderHermesJsonCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${OPEN}\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n${CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class HermesJsonRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, OPEN], recoverHermesJsonCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverHermesJsonFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new HermesJsonRecovery(tools), text);
}
