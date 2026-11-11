/**
 * The `minimax-ns-xml` dialect: MiniMax-M3 writes every tag of a call behind a
 * namespace token, `]<]minimax[>[`,
 *
 *   ]<]minimax[>[<tool_call>
 *   ]<]minimax[>[<invoke name="get_weather">]<]minimax[>[<city>Paris]<]minimax[>[</city>]<]minimax[>[</invoke>
 *   ]<]minimax[>[</tool_call>
 *
 * A parameter is a tag named for the key; a nested object is expanded into
 * one tag per key and an array into one `<item>` per element.
 *
 * Source, read 2026-11-10: the MiniMax-M3 chat template
 * (https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/chat_template.jinja):
 * "To call tools, wrap all invocations in a single `]<]minimax[>[<tool_call>`
 * ... `]<]minimax[>[</tool_call>` block. Parameter values containing nested
 * objects or arrays are recursively expanded into XML elements", with the
 * `to_xml` macro and the assistant-message rendering as the exact layout;
 * thinking is `<mm:think>...</mm:think>`, and a turn with no thinking begins
 * with a bare `</mm:think>`. `added_tokens.json` and tokenizer_config.json list
 * `]<]minimax[>[` (id 200058) as a token with `special: false`, so a server
 * does not strip it and the stream carries it. A null value is omitted by the
 * template. No live capture exists (the family was not reachable), so every
 * fixture is synthesised and the parser is opt-in
 * (`toolDialect: minimax-ns-xml`).
 *
 * Strict. The whole reply must be an optional leading thinking block (kept as
 * text) and then exactly one `]<]minimax[>[<tool_call>` block of invokes for
 * declared tools. A scalar is a string verbatim, or for a declared
 * integer/number/boolean the canonical literal it spells; nested values are
 * typed by the schema's `properties` and `items` and a leaf with no declared
 * type stays a string. Arguments must fit the schema; a duplicate key, an
 * unclosed tag or text outside the structure refuses the whole reply.
 */
import {
  HeldBlockRecovery,
  type ParsedReply,
  recoverWhole,
  skipSpace,
} from "./heldRecovery.js";
import { coerceToSchema, fittedCall } from "./schemaCheck.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const NS = "]<]minimax[>[";
const OPEN = `${NS}<tool_call>`;
const CLOSE = `${NS}</tool_call>`;
const INVOKE = `${NS}<invoke name="`;
const INVOKE_CLOSE = `${NS}</invoke>`;
const THINK_OPEN = "<mm:think>";
const THINK_CLOSE = "</mm:think>";
const TAG = /^[^<>\s/"&]+$/;

interface Node {
  type?: string | string[];
  properties?: Record<string, Node | undefined>;
  items?: Node;
}

function typesOf(node: Node | undefined): string[] {
  const t = node?.type;
  return Array.isArray(t) ? t : t ? [t] : [];
}

/** The leading thinking block (or bare close the template writes), with the space after it. */
function leadingThink(s: string): string {
  const lead = s.length - s.trimStart().length;
  let end = -1;
  if (s.startsWith(THINK_CLOSE, lead)) end = lead + THINK_CLOSE.length;
  else if (s.startsWith(THINK_OPEN, lead)) {
    const close = s.indexOf(THINK_CLOSE, lead);
    if (close !== -1) end = close + THINK_CLOSE.length;
  }
  if (end === -1) return "";
  return s.slice(0, skipSpace(s, end));
}

/** A leaf's text as the schema declares it, undefined when it cannot fit. */
function leaf(
  raw: string,
  node: Node | undefined,
): { value: unknown } | undefined {
  const types = typesOf(node);
  if (raw === "" && !types.includes("string") && types.length > 0) {
    if (types.includes("array")) return { value: [] };
    if (types.includes("object")) return { value: {} };
  }
  const fit = coerceToSchema(raw, node?.type);
  return fit ? { value: fit.value } : undefined;
}

/** A parsed value and the index after its closing tag. */
type Parsed = { value: unknown; next: number } | undefined;

function closeTag(name: string): string {
  return `${NS}</${name}>`;
}

/** The name of the tag opening at `at` (just after the namespace token). */
function openName(
  text: string,
  at: number,
): { name: string; next: number } | undefined {
  if (!text.startsWith(`${NS}<`, at)) return undefined;
  const end = text.indexOf(">", at + NS.length);
  const name = end === -1 ? "" : text.slice(at + NS.length + 1, end);
  return TAG.test(name) ? { name, next: end + 1 } : undefined;
}

/** Children as an array (all `item`) or an object, as the schema allows. */
function collect(
  entries: [string, unknown][],
  node: Node | undefined,
): unknown {
  const types = typesOf(node);
  const allItems = entries.every(([k]) => k === "item");
  const asArray = types.includes("array")
    ? allItems
    : !types.includes("object") && allItems;
  if (asArray) return entries.map(([, v]) => v);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (k in obj) return undefined;
    obj[k] = v;
  }
  return obj;
}

/** The value of tag `name` whose content starts at `pos`, per schema `node`. */
function parseValue(
  text: string,
  pos: number,
  name: string,
  node: Node | undefined,
): Parsed {
  const close = closeTag(name);
  const nested =
    text.startsWith(`${NS}<`, pos) && !text.startsWith(`${NS}</`, pos);
  if (!nested) {
    const end = text.indexOf(close, pos);
    const raw = end === -1 ? "" : text.slice(pos, end);
    if (end === -1 || raw.includes(NS)) return undefined;
    const got = leaf(raw, node);
    return got ? { value: got.value, next: end + close.length } : undefined;
  }
  const entries: [string, unknown][] = [];
  let at = pos;
  while (!text.startsWith(close, at)) {
    const child = openName(text, at);
    if (!child) return undefined;
    const sub =
      child.name === "item" && !typesOf(node).includes("object")
        ? node?.items
        : node?.properties?.[child.name];
    const got = parseValue(text, child.next, child.name, sub);
    if (!got) return undefined;
    entries.push([child.name, got.value]);
    at = got.next;
  }
  const value = collect(entries, node);
  return value === undefined ? undefined : { value, next: at + close.length };
}

function parseInvoke(
  text: string,
  pos: number,
  tools: DialectTool[],
): { call: RecoveredCall; next: number } | undefined {
  const nameStart = pos + INVOKE.length;
  const nameEnd = text.indexOf('">', nameStart);
  const tool =
    nameEnd === -1
      ? undefined
      : tools.find((t) => t.name === text.slice(nameStart, nameEnd));
  if (!tool) return undefined;
  const schema = (tool.parameters ?? {}) as Node;
  const args: Record<string, unknown> = {};
  let at = nameEnd + 2;
  while (!text.startsWith(INVOKE_CLOSE, at)) {
    const key = openName(text, at);
    if (!key || key.name in args) return undefined;
    const got = parseValue(
      text,
      key.next,
      key.name,
      schema.properties?.[key.name],
    );
    if (!got) return undefined;
    args[key.name] = got.value;
    at = got.next;
  }
  const next = at + INVOKE_CLOSE.length;
  const call = fittedCall(tool, args, text.slice(pos, next));
  return call ? { call, next } : undefined;
}

/** The calls in `text` when all of it is one M3 call block, else undefined. */
export function recoverMinimaxNsCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  let pos = skipSpace(text, lead.length);
  if (!text.startsWith(OPEN, pos)) return undefined;
  pos += OPEN.length;
  const calls: RecoveredCall[] = [];
  for (;;) {
    pos = skipSpace(text, pos);
    if (text.startsWith(CLOSE, pos)) break;
    if (!text.startsWith(INVOKE, pos)) return undefined;
    const invoke = parseInvoke(text, pos, tools);
    if (!invoke) return undefined;
    calls.push(invoke.call);
    pos = invoke.next;
  }
  pos = skipSpace(text, pos + CLOSE.length);
  return calls.length > 0 && pos >= text.length ? { lead, calls } : undefined;
}

function renderParams(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${NS}<${k}>${renderValue(v)}${closeTag(k)}`)
    .join("");
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => `${NS}<item>${renderValue(x)}${closeTag("item")}`)
      .join("");
  }
  if (v && typeof v === "object")
    return renderParams(v as Record<string, unknown>);
  return typeof v === "boolean" ? JSON.stringify(v) : String(v);
}

/** A block in the form MiniMax-M3 writes it, for round-trip tests. */
export function renderMinimaxNsCalls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  const invokes = calls
    .map(
      (c) =>
        `${INVOKE}${c.name}">${renderParams(c.arguments)}${INVOKE_CLOSE}\n`,
    )
    .join("");
  return `${OPEN}\n${invokes}${CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class MinimaxNsRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, THINK_CLOSE, OPEN], recoverMinimaxNsCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverMinimaxNsFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new MinimaxNsRecovery(tools), text);
}
