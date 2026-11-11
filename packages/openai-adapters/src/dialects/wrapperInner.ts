/**
 * The inner grammars of the wrapper dialects (wrapperDialects.ts). Each takes
 * the text between a family's open and close markers and returns the calls it
 * holds, or undefined when any of it is not exactly that grammar. Nothing here
 * knows a marker of the family it serves; the rows in wrapperDialects.ts bind
 * a grammar to its markers and cite the source of the form.
 *
 * All of them are strict in the way the other dialects are: a call names a
 * declared tool, every argument fits the schema (`fittedCall`), and a body
 * with anything left over is refused whole.
 */
import { parsePythonicCall, recoverPythonicCalls } from "./pythonic.js";
import { recoverQwenXmlCalls } from "./qwenXml.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";
import { declaredType, fittedCall } from "./schemaCheck.js";
import { skipSpace } from "./heldRecovery.js";

/** Parses the text between a family's markers into the calls it holds. */
export type InnerParser = (
  body: string,
  tools: DialectTool[],
) => RecoveredCall[] | undefined;

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

/** The keys one JSON call object is written with. */
export interface JsonCallShape {
  /** The key holding the tool name. */
  name: string;
  /** The key holding the arguments object. */
  args: string;
  /** Keys that may also be present (an id), never required, strings only. */
  optional?: string[];
}

function jsonCall(
  value: unknown,
  shape: JsonCallShape,
  tools: DialectTool[],
): RecoveredCall | undefined {
  if (!isObject(value)) return undefined;
  const allowed = [shape.name, shape.args, ...(shape.optional ?? [])];
  if (Object.keys(value).some((k) => !allowed.includes(k))) return undefined;
  if (shape.optional?.some((k) => k in value && typeof value[k] !== "string")) {
    return undefined;
  }
  const tool = tools.find((t) => t.name === value[shape.name]);
  const args = value[shape.args];
  if (!tool || !isObject(args)) return undefined;
  return fittedCall(tool, args, "");
}

/** A JSON array of call objects: `[{"name": ..., "arguments": {...}}, ...]`. */
export function jsonArray(shape: JsonCallShape): InnerParser {
  return (body, tools) => {
    const value = parseJson(body.trim());
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const calls = value.map((v) => jsonCall(v, shape, tools));
    return calls.every((c) => c !== undefined)
      ? (calls as RecoveredCall[])
      : undefined;
  };
}

/** One JSON call object: `{"name": ..., "arguments": {...}}`. */
export function jsonObject(shape: JsonCallShape): InnerParser {
  return (body, tools) => {
    const call = jsonCall(parseJson(body.trim()), shape, tools);
    return call ? [call] : undefined;
  };
}

/** A Python list of calls: `[a(x=1), b(y='z')]`, a non-empty list. */
export const pythonicList: InnerParser = (body, tools) => {
  const text = body.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return undefined;
  const calls: RecoveredCall[] = [];
  let at = 1;
  for (;;) {
    at = skipSpace(text, at);
    const one = parsePythonicCall(text, at, tools);
    if (!one) return undefined;
    calls.push(one.call);
    at = skipSpace(text, one.end);
    if (text[at] === ",") {
      at++;
      continue;
    }
    return text[at] === "]" && at === text.length - 1 ? calls : undefined;
  }
};

/** Python calls one after another, separated by whitespace (Olmo 3). */
export const pythonicLines: InnerParser = (body, tools) =>
  recoverPythonicCalls(body, tools);

/**
 * One `<function=NAME><parameter=KEY>value</parameter></function>` (Seed-OSS):
 * the Qwen3-Coder inner markup, read by the qwen-xml parser. A body that is
 * not exactly one such call (another wrapper tag, two functions) is refused.
 */
export const qwenInvoke: InnerParser = (body, tools) => {
  if (!body.trimStart().startsWith("<function=")) return undefined;
  const calls = recoverQwenXmlCalls(body, tools);
  return calls?.length === 1 ? calls : undefined;
};

/** Tag names of a key/value tag call: `NAME<sep>` then key and value pairs. */
export interface KeyValueTags {
  callOpen: string;
  callClose: string;
  sep: string;
  keyOpen: string;
  keyClose: string;
  valOpen: string;
  valClose: string;
}

/** The tags of a key/value tag family whose every tag carries `suffix`. */
export function suffixedKeyValueTags(suffix: string): KeyValueTags {
  return {
    callOpen: `<tool_call${suffix}>`,
    callClose: `</tool_call${suffix}>`,
    sep: `<tool_sep${suffix}>`,
    keyOpen: `<arg_key${suffix}>`,
    keyClose: `</arg_key${suffix}>`,
    valOpen: `<arg_value${suffix}>`,
    valClose: `</arg_value${suffix}>`,
  };
}

/** The `</arg_value>` that really ends the value starting at `from`. */
function valueEnd(s: string, from: number, t: KeyValueTags): number {
  for (let i = s.indexOf(t.valClose, from); i !== -1;) {
    const next = skipSpace(s, i + t.valClose.length);
    if (s.startsWith(t.keyOpen, next) || s.startsWith(t.callClose, next)) {
      return i;
    }
    i = s.indexOf(t.valClose, i + 1);
  }
  return -1;
}

/**
 * A string value is taken verbatim; a value for a parameter whose declared
 * type is anything else must be JSON; a parameter with no declared type is a
 * string. The template writes strings raw and every other value as JSON.
 */
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
  const value = parseJson(raw.trim());
  return value === undefined ? { ok: false } : { ok: true, value };
}

function keyValueCall(
  text: string,
  pos: number,
  t: KeyValueTags,
  tools: DialectTool[],
): { call: RecoveredCall; next: number } | undefined {
  const nameStart = pos + t.callOpen.length;
  const sepAt = text.indexOf(t.sep, nameStart);
  if (sepAt === -1) return undefined;
  const tool = tools.find(
    (x) => x.name === text.slice(nameStart, sepAt).trim(),
  );
  if (!tool) return undefined;
  const args: Record<string, unknown> = {};
  let at = sepAt + t.sep.length;
  for (;;) {
    at = skipSpace(text, at);
    if (text.startsWith(t.callClose, at)) break;
    if (!text.startsWith(t.keyOpen, at)) return undefined;
    const keyEnd = text.indexOf(t.keyClose, at);
    if (keyEnd === -1) return undefined;
    const key = text.slice(at + t.keyOpen.length, keyEnd).trim();
    if (!key || key in args) return undefined;
    at = skipSpace(text, keyEnd + t.keyClose.length);
    if (!text.startsWith(t.valOpen, at)) return undefined;
    at += t.valOpen.length;
    const end = valueEnd(text, at, t);
    if (end === -1) return undefined;
    const typed = typedValue(tool, key, text.slice(at, end));
    if (!typed.ok) return undefined;
    args[key] = typed.value;
    at = end + t.valClose.length;
  }
  const next = at + t.callClose.length;
  const call = fittedCall(tool, args, "");
  return call ? { call, next } : undefined;
}

/** One or more key/value tag calls, nothing between them but whitespace. */
export function keyValueCalls(tags: KeyValueTags): InnerParser {
  return (body, tools) => {
    const calls: RecoveredCall[] = [];
    let pos = skipSpace(body, 0);
    while (pos < body.length) {
      if (!body.startsWith(tags.callOpen, pos)) return undefined;
      const one = keyValueCall(body, pos, tags, tools);
      if (!one) return undefined;
      calls.push(one.call);
      pos = skipSpace(body, one.next);
    }
    return calls.length > 0 ? calls : undefined;
  };
}

/** Separators of an `ID <name> NAME <args> JSON` body (Solar Open). */
export interface IdNameArgs {
  /** The id's pattern, whole-string. */
  id: RegExp;
  nameSep: string;
  argsSep: string;
}

/** `ID` + nameSep + `NAME` + argsSep + a JSON object of arguments. */
export function idNameArgs(shape: IdNameArgs): InnerParser {
  return (body, tools) => {
    const nameAt = body.indexOf(shape.nameSep);
    if (nameAt === -1) return undefined;
    const argsAt = body.indexOf(shape.argsSep, nameAt);
    if (argsAt === -1) return undefined;
    if (!shape.id.test(body.slice(0, nameAt))) return undefined;
    const tool = tools.find(
      (t) => t.name === body.slice(nameAt + shape.nameSep.length, argsAt),
    );
    const args = parseJson(body.slice(argsAt + shape.argsSep.length).trim());
    if (!tool || !isObject(args)) return undefined;
    const call = fittedCall(tool, args, "");
    return call ? [call] : undefined;
  };
}
