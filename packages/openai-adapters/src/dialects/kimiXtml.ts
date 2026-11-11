/**
 * The `kimi-xtml` dialect: Kimi K3 writes a turn in "XTML", tags made of three
 * marker tokens, `<|open|>`, `<|sep|>` and `<|close|>`. The tool calls of an
 * assistant turn are
 *
 *   <|open|>tools<|sep|>
 *   <|open|>call tool="get_weather" index="1"<|sep|>
 *   <|open|>argument key="city" type="string"<|sep|>Paris<|close|>argument<|sep|>
 *   <|close|>call<|sep|>
 *   <|close|>tools<|sep|>
 *
 * (no whitespace is written; it is split here for reading).
 *
 * Source, read 2026-11-10: the vendor's renderer `encoding_k3.py` in
 * https://huggingface.co/moonshotai/Kimi-K3 (`_open_tag`, `_close_tag`,
 * `_attr`, `_xtml_type`, `_render_assistant_segments`): `_open_tag(tag,
 * attrs)` is `<|open|>` + tag + ` key="value"` for each attribute + `<|sep|>`;
 * `_close_tag(tag)` is `<|close|>` + tag + `<|sep|>`; an attribute value
 * escapes `&` as `&amp;` and `"` as `&quot;`; a call is `call` with attributes
 * `tool` and `index` (1-based), an argument is `argument` with `key` and
 * `type`, where type is one of string, number, boolean, null, object, array;
 * a string argument's text is the string itself and any other type's text is
 * its JSON literal. A turn is `message role="assistant"` holding `think` (the
 * generation prompt opens it), `response` (the visible text) and then `tools`.
 * Arguments that were not a JSON object are written as `<json type="object">`
 * raw text; that form is not recovered. The tokenizer_config.json of the repo
 * lists the three markers with `special: false`, so a server does not strip
 * them. This is the form the vendor trains on and renders history in; no live
 * capture exists (K3 was not reachable on Bedrock), so every fixture is
 * synthesised and the parser is opt-in (`toolDialect: kimi-xtml`).
 *
 * Strict. The whole reply must be, in order: an optional think part (an
 * `<|open|>think<|sep|>` ... `<|close|>think<|sep|>` block, or just the close
 * tag when the server sent the opening), an optional `response` part (kept as
 * text), one `tools` part, and optionally `<|close|>message<|sep|>` and
 * `<|end_of_msg|>`. Every call names a declared tool, `index` counts 1, 2, ...
 * in order, and each argument's `type` must agree with its text (a string
 * `type` for text, JSON of that type otherwise) and fit the schema. A
 * duplicate key, an undeclared key or any other shape stays text.
 */
import {
  HeldBlockRecovery,
  type ParsedReply,
  recoverWhole,
  skipSpace,
} from "./heldRecovery.js";
import { fittedCall } from "./schemaCheck.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const OPEN = "<|open|>";
const CLOSE = "<|close|>";
const SEP = "<|sep|>";
const END_OF_MSG = "<|end_of_msg|>";
const THINK_OPEN = `${OPEN}think${SEP}`;
const THINK_CLOSE = `${CLOSE}think${SEP}`;
const RESPONSE_OPEN = `${OPEN}response${SEP}`;
const RESPONSE_CLOSE = `${CLOSE}response${SEP}`;
const TOOLS_OPEN = `${OPEN}tools${SEP}`;
const TOOLS_CLOSE = `${CLOSE}tools${SEP}`;
const CALL_CLOSE = `${CLOSE}call${SEP}`;
const ARG_CLOSE = `${CLOSE}argument${SEP}`;
const MESSAGE_CLOSE = `${CLOSE}message${SEP}`;
const TYPES = ["string", "number", "boolean", "null", "object", "array"];

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** `<|open|>TAG a="x" b="y"<|sep|>` at `at`: the attribute values and the next index. */
function openTag(
  text: string,
  at: number,
  tag: string,
  keys: string[],
): { values: string[]; next: number } | undefined {
  let pos = at + OPEN.length + tag.length;
  if (!text.startsWith(`${OPEN}${tag}`, at)) return undefined;
  const values: string[] = [];
  for (const key of keys) {
    const head = ` ${key}="`;
    if (!text.startsWith(head, pos)) return undefined;
    const end = text.indexOf('"', pos + head.length);
    if (end === -1) return undefined;
    values.push(unescapeAttr(text.slice(pos + head.length, end)));
    pos = end + 1;
  }
  return text.startsWith(SEP, pos)
    ? { values, next: pos + SEP.length }
    : undefined;
}

/** The value an argument's text stands for under its stated type. */
function typedText(type: string, raw: string): { value: unknown } | undefined {
  if (type === "string") return { value: raw };
  let v: unknown;
  try {
    v = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  const kind =
    v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : typeof v === "object"
          ? "object"
          : typeof v;
  return kind === type ? { value: v } : undefined;
}

function parseArgument(
  text: string,
  at: number,
): { key: string; value: unknown; next: number } | undefined {
  const head = openTag(text, at, "argument", ["key", "type"]);
  if (!head || !TYPES.includes(head.values[1])) return undefined;
  const end = text.indexOf(ARG_CLOSE, head.next);
  if (end === -1) return undefined;
  const typed = typedText(head.values[1], text.slice(head.next, end));
  return typed && head.values[0]
    ? { key: head.values[0], value: typed.value, next: end + ARG_CLOSE.length }
    : undefined;
}

function parseCall(
  text: string,
  at: number,
  index: number,
  tools: DialectTool[],
): { call: RecoveredCall; next: number } | undefined {
  const head = openTag(text, at, "call", ["tool", "index"]);
  if (!head || head.values[1] !== String(index)) return undefined;
  const tool = tools.find((t) => t.name === head.values[0]);
  if (!tool) return undefined;
  const args: Record<string, unknown> = {};
  let pos = head.next;
  while (!text.startsWith(CALL_CLOSE, pos)) {
    const arg = parseArgument(text, skipSpace(text, pos));
    if (!arg || arg.key in args) return undefined;
    args[arg.key] = arg.value;
    pos = skipSpace(text, arg.next);
  }
  const next = pos + CALL_CLOSE.length;
  const call = fittedCall(tool, args, text.slice(at, next));
  return call ? { call, next } : undefined;
}

/** Index just after `open`...`close` when `text` has one at `pos`; -1 unclosed; `pos` when absent. */
function skipPart(text: string, pos: number, open: string, close: string) {
  if (!text.startsWith(open, pos)) return pos;
  const end = text.indexOf(close, pos + open.length);
  return end === -1 ? -1 : skipSpace(text, end + close.length);
}

/** End of the think and response parts at the start of `text`, or -1. */
function leadEnd(text: string): number {
  let pos = skipSpace(text, 0);
  if (text.startsWith(THINK_CLOSE, pos)) {
    pos = skipSpace(text, pos + THINK_CLOSE.length);
  } else {
    pos = skipPart(text, pos, THINK_OPEN, THINK_CLOSE);
  }
  return pos === -1 ? -1 : skipPart(text, pos, RESPONSE_OPEN, RESPONSE_CLOSE);
}

/** The calls in `text` when all of it is one K3 assistant turn, else undefined. */
export function recoverKimiXtmlCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const leadAt = leadEnd(text);
  if (leadAt === -1 || !text.startsWith(TOOLS_OPEN, leadAt)) return undefined;
  let pos = leadAt + TOOLS_OPEN.length;
  const calls: RecoveredCall[] = [];
  while (!text.startsWith(TOOLS_CLOSE, skipSpace(text, pos))) {
    const block = parseCall(
      text,
      skipSpace(text, pos),
      calls.length + 1,
      tools,
    );
    if (!block) return undefined;
    calls.push(block.call);
    pos = block.next;
  }
  pos = skipSpace(text, skipSpace(text, pos) + TOOLS_CLOSE.length);
  for (const tail of [MESSAGE_CLOSE, END_OF_MSG]) {
    if (text.startsWith(tail, pos)) pos = skipSpace(text, pos + tail.length);
  }
  return calls.length > 0 && pos >= text.length
    ? { lead: text.slice(0, leadAt), calls }
    : undefined;
}

function xtmlType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

/** A tools part in the form K3 writes it, for round-trip tests. */
export function renderKimiXtmlCalls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  const body = calls
    .map((c, i) => {
      const args = Object.entries(c.arguments)
        .map(([k, v]) => {
          const text = typeof v === "string" ? v : JSON.stringify(v);
          return `${OPEN}argument key="${k}" type="${xtmlType(v)}"${SEP}${text}${ARG_CLOSE}`;
        })
        .join("");
      return `${OPEN}call tool="${c.name}" index="${i + 1}"${SEP}${args}${CALL_CLOSE}`;
    })
    .join("");
  return `${TOOLS_OPEN}${body}${TOOLS_CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class KimiXtmlRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(
      tools,
      [THINK_OPEN, THINK_CLOSE, RESPONSE_OPEN, TOOLS_OPEN],
      recoverKimiXtmlCalls,
    );
  }
}

/** One-shot form for a complete reply. */
export function recoverKimiXtmlFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new KimiXtmlRecovery(tools), text);
}
