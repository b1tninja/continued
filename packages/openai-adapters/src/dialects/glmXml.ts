/**
 * The `glm-xml` dialect: GLM-4.5/4.6/4.7 write a call as a name followed by
 * key/value tag pairs inside `<tool_call>`,
 *
 *   <tool_call>get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value></tool_call>
 *
 * GLM-4.5 and 4.6 lay the tags out one per line; 4.7 writes them adjacent.
 * Parallel calls are adjacent `<tool_call>` blocks. A string value is written
 * verbatim, any other value as JSON. Source: the GLM-4.5, 4.6 and 4.7 chat
 * templates (plans/tool-dialect-reference.md), read 2026-11-10. No live
 * capture exists (GLM 4.7 and 5 returned structured calls on Bedrock), so this
 * parser is opt-in (`toolDialect: glm-xml`) only.
 *
 * Strict. The whole reply must be an optional leading `<think>` block (kept
 * as text) and then only `<tool_call>` blocks. The name is a declared tool.
 * A value for an argument whose schema says `string` is taken verbatim; any
 * other declared type must parse as JSON and fit it; an argument with no
 * declared type is a string. Arguments must fit the schema. One repair is
 * made, the one reported live (vLLM#49248): a missing `<arg_value>` opener
 * after `</arg_key>`. A literal `</arg_value>` inside a value is kept when it
 * is not followed by the next tag.
 */
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import { declaredType, fittedCall } from "./schemaCheck.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const KEY_OPEN = "<arg_key>";
const KEY_CLOSE = "</arg_key>";
const VAL_OPEN = "<arg_value>";
const VAL_CLOSE = "</arg_value>";

/** Index of the `</arg_value>` that really ends a value starting at `from`. */
function valueEnd(s: string, from: number): number {
  for (let i = s.indexOf(VAL_CLOSE, from); i !== -1;) {
    const next = skipSpace(s, i + VAL_CLOSE.length);
    if (s.startsWith(KEY_OPEN, next) || s.startsWith(CLOSE, next)) return i;
    i = s.indexOf(VAL_CLOSE, i + 1);
  }
  return -1;
}

function typedValue(
  tool: DialectTool,
  key: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  const type = declaredType(tool, key);
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0 || types.includes("string")) {
    return { ok: true, value: raw };
  }
  try {
    return { ok: true, value: JSON.parse(raw.trim()) };
  } catch {
    return { ok: false };
  }
}

/** One block starting at `pos`: the call and the index after it. */
function parseBlock(
  text: string,
  pos: number,
  tools: DialectTool[],
): { call: RecoveredCall; next: number } | undefined {
  const bodyStart = pos + OPEN.length;
  const firstKey = text.indexOf(KEY_OPEN, bodyStart);
  const closeAt = text.indexOf(CLOSE, bodyStart);
  const nameEnd =
    firstKey !== -1 && (closeAt === -1 || firstKey < closeAt)
      ? firstKey
      : closeAt;
  if (nameEnd === -1) return undefined;
  const tool = tools.find(
    (t) => t.name === text.slice(bodyStart, nameEnd).trim(),
  );
  if (!tool) return undefined;
  const args: Record<string, unknown> = {};
  let at = nameEnd;
  for (;;) {
    at = skipSpace(text, at);
    if (text.startsWith(CLOSE, at)) break;
    if (!text.startsWith(KEY_OPEN, at)) return undefined;
    const keyEnd = text.indexOf(KEY_CLOSE, at);
    if (keyEnd === -1) return undefined;
    const key = text.slice(at + KEY_OPEN.length, keyEnd).trim();
    if (!key || key in args) return undefined;
    at = skipSpace(text, keyEnd + KEY_CLOSE.length);
    if (text.startsWith(VAL_OPEN, at)) at += VAL_OPEN.length;
    const end = valueEnd(text, at);
    if (end === -1) return undefined;
    const typed = typedValue(tool, key, text.slice(at, end));
    if (!typed.ok) return undefined;
    args[key] = typed.value;
    at = end + VAL_CLOSE.length;
  }
  const next = at + CLOSE.length;
  const call = fittedCall(tool, args, text.slice(pos, next));
  return call ? { call, next } : undefined;
}

/** The calls in `text` when all of it is GLM calls, else undefined. */
export function recoverGlmXmlCalls(
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
    const block = parseBlock(text, pos, tools);
    if (!block) return undefined;
    calls.push(block.call);
    pos = block.next;
  }
  return calls.length > 0 ? { lead, calls } : undefined;
}

/** A call in the form GLM-4.7 writes it, for round-trip tests. */
export function renderGlmXmlCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  const pairs = Object.entries(call.arguments)
    .map(([k, v]) => {
      const value = typeof v === "string" ? v : JSON.stringify(v);
      return `${KEY_OPEN}${k}${KEY_CLOSE}${VAL_OPEN}${value}${VAL_CLOSE}`;
    })
    .join("");
  return `${OPEN}${call.name}${pairs}${CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class GlmXmlRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, OPEN], recoverGlmXmlCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverGlmXmlFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new GlmXmlRecovery(tools), text);
}
