/**
 * The `kimi-tokens` dialect: Kimi K2 and K2-Thinking write calls between
 * special-token markers,
 *
 *   <|tool_calls_section_begin|>
 *   <|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Paris"}<|tool_call_end|>
 *   <|tool_calls_section_end|>
 *
 * Sources, read 2026-11-10: the Kimi-K2-Thinking chat template
 * (https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/main/chat_template.jinja,
 * macro `render_toolcalls`: section begin, then per call `<|tool_call_begin|>`
 * id `<|tool_call_argument_begin|>` the arguments as one JSON text
 * `<|tool_call_end|>`, section end) and the vendor's tool-calling guide
 * (.../docs/tool_call_guidance.md, "Manually Parsing Tool Calls": "The format
 * of the tool ID is `functions.{func_name}:{idx}`, from which we can parse the
 * function name"; its reference regex allows whitespace around the id and the
 * arguments). K2-Thinking on Bedrock Converse returned structured calls with
 * ids of this shape (`functions.read_file:0`); no text form was captured, so
 * every corpus fixture is synthesised and the parser is opt-in
 * (`toolDialect: kimi-tokens`).
 *
 * The markers are special tokens: a server that strips special tokens from
 * content leaves `functions.NAME:0{...}`, which is indistinguishable from
 * prose, so only the marker-present stream is recovered.
 *
 * Strict. The whole reply must be an optional leading `<think>` block (kept
 * as text) and then one section of calls and nothing else. Each id must be
 * `functions.NAME:IDX` with NAME a declared tool and ids unique; the
 * arguments must be one JSON object that fits the tool's schema. Anything
 * else (an id without a name, malformed JSON, an unclosed section) stays text.
 */
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import { fittedCall } from "./schemaCheck.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const SECTION_OPEN = "<|tool_calls_section_begin|>";
const SECTION_CLOSE = "<|tool_calls_section_end|>";
const CALL_OPEN = "<|tool_call_begin|>";
const ARG_OPEN = "<|tool_call_argument_begin|>";
const CALL_CLOSE = "<|tool_call_end|>";
const ID = /^functions\.(.+):(\d+)$/s;

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One call starting at `pos` (at CALL_OPEN): the call and the index after it. */
function parseCall(
  text: string,
  pos: number,
  tools: DialectTool[],
  seen: Set<string>,
): { call: RecoveredCall; next: number } | undefined {
  const idStart = pos + CALL_OPEN.length;
  const argAt = text.indexOf(ARG_OPEN, idStart);
  if (argAt === -1) return undefined;
  const id = text.slice(idStart, argAt).trim();
  const named = ID.exec(id);
  if (!named || seen.has(id)) return undefined;
  const tool = tools.find((t) => t.name === named[1]);
  if (!tool) return undefined;
  const endAt = text.indexOf(CALL_CLOSE, argAt);
  if (endAt === -1) return undefined;
  const args = parseObject(text.slice(argAt + ARG_OPEN.length, endAt).trim());
  if (!args) return undefined;
  const next = endAt + CALL_CLOSE.length;
  const call = fittedCall(tool, args, text.slice(pos, next));
  if (!call) return undefined;
  seen.add(id);
  return { call, next };
}

/** The calls in `text` when all of it is one Kimi section, else undefined. */
export function recoverKimiTokensCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  let pos = skipSpace(text, lead.length);
  if (!text.startsWith(SECTION_OPEN, pos)) return undefined;
  pos += SECTION_OPEN.length;
  const calls: RecoveredCall[] = [];
  const seen = new Set<string>();
  for (;;) {
    pos = skipSpace(text, pos);
    if (text.startsWith(SECTION_CLOSE, pos)) break;
    if (!text.startsWith(CALL_OPEN, pos)) return undefined;
    const block = parseCall(text, pos, tools, seen);
    if (!block) return undefined;
    calls.push(block.call);
    pos = block.next;
  }
  pos = skipSpace(text, pos + SECTION_CLOSE.length);
  return calls.length > 0 && pos >= text.length ? { lead, calls } : undefined;
}

/** A section in the form Kimi writes it, for round-trip tests. */
export function renderKimiTokensCalls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  const body = calls
    .map(
      (c, i) =>
        `${CALL_OPEN}functions.${c.name}:${i}${ARG_OPEN}${JSON.stringify(c.arguments)}${CALL_CLOSE}`,
    )
    .join("");
  return `${SECTION_OPEN}${body}${SECTION_CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class KimiTokensRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, SECTION_OPEN], recoverKimiTokensCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverKimiTokensFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new KimiTokensRecovery(tools), text);
}
