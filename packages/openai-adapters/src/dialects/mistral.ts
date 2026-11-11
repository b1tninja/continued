/**
 * The `mistral` dialect: Mistral, Mistral Small, Devstral and Magistral write
 * a call after the control token `[TOOL_CALLS]`, in one of two layouts:
 *
 *   v3 (Mistral 7B v0.3, Mixtral 8x22B v0.3, Large 2 ...):
 *   [TOOL_CALLS] [{"name": "get_weather", "arguments": {"city": "Paris"}, "id": "AbCdEf123"}]
 *
 *   v11 and later (Mistral Small 3, Devstral, Magistral ...), one marker per call:
 *   [TOOL_CALLS]get_weather[ARGS]{"city": "Paris"}[TOOL_CALLS]get_time[ARGS]{"tz": "UTC"}
 *
 * Sources, read 2026-11-10:
 * - https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/blob/main/
 *   tokenizer_config.json (chat_template): `"[TOOL_CALLS] ["`, each call as
 *   `tool_call.function|tojson` with `, "id": "<9 characters>"}` appended,
 *   `"]"` then the end token. An assistant message with tool calls carries no
 *   content in that template.
 * - https://github.com/mistralai/mistral-common, src/mistral_common/tokens/
 *   tokenizers/instruct.py: InstructTokenizerV3 writes `[TOOL_CALLS]` followed
 *   by `json.dumps([{"name", "arguments", "id"?}, ...])`; InstructTokenizerV11
 *   writes, per call, `[TOOL_CALLS]` name (`[CALL_ID]` id)? `[ARGS]`
 *   `json.dumps(arguments)`; V13 drops the call id.
 * - https://huggingface.co/unsloth/Devstral-Small-2507/blob/main/
 *   chat_template.jinja: `"[TOOL_CALLS]" + name + "[ARGS]" + arguments`.
 *
 * Mistral models return structured calls on Bedrock Converse; this parser
 * matters for a self-hosted server that returns the raw tokens in the
 * content. Opt-in.
 *
 * Strict. The whole reply is one layout, nothing else (an opening `<think>`
 * block is kept as text): v3 is `[TOOL_CALLS]`, optional whitespace, a
 * non-empty JSON array of objects with exactly `name`, `arguments` (an
 * object) and an optional string `id`; v11 is one or more `[TOOL_CALLS]NAME
 * ([CALL_ID]ID)?[ARGS]OBJECT`. Every name is a declared tool and every
 * argument fits its schema. Prose before or after the calls, a mixture of the
 * layouts, a truncated call or any bad call leaves the reply as text.
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
import { isObject, jsonValueEnd, parseJson } from "./jsonText.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const MARK = "[TOOL_CALLS]";
const ARGS = "[ARGS]";
const CALL_ID = "[CALL_ID]";

function callFrom(
  name: unknown,
  args: unknown,
  tools: DialectTool[],
  raw: string,
): RecoveredCall | undefined {
  const tool = tools.find((t) => t.name === name);
  return tool && isObject(args) ? fittedCall(tool, args, raw) : undefined;
}

/** The v3 layout: one array after the marker at `pos`. */
function parseArray(
  text: string,
  pos: number,
  tools: DialectTool[],
): RecoveredCall[] | undefined {
  const start = skipSpace(text, pos + MARK.length);
  if (text[start] !== "[") return undefined;
  const end = jsonValueEnd(text, start);
  if (end === -1 || skipSpace(text, end) !== text.length) return undefined;
  const items = parseJson(text.slice(start, end));
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const calls: RecoveredCall[] = [];
  for (const item of items) {
    if (!isObject(item)) return undefined;
    const keys = Object.keys(item);
    if (keys.some((k) => !["name", "arguments", "id"].includes(k))) {
      return undefined;
    }
    if ("id" in item && typeof item.id !== "string") return undefined;
    const call = callFrom(
      item.name,
      item.arguments,
      tools,
      JSON.stringify(item),
    );
    if (!call) return undefined;
    calls.push(call);
  }
  return calls;
}

/** The v11 layout: every call is `[TOOL_CALLS]NAME[ARGS]OBJECT`. */
function parseArgsForm(
  text: string,
  from: number,
  tools: DialectTool[],
): RecoveredCall[] | undefined {
  const calls: RecoveredCall[] = [];
  let pos = from;
  while (pos < text.length) {
    if (!text.startsWith(MARK, pos)) return undefined;
    const begin = pos;
    const nameStart = pos + MARK.length;
    const argsAt = text.indexOf(ARGS, nameStart);
    if (argsAt === -1) return undefined;
    let name = text.slice(nameStart, argsAt);
    const idAt = name.indexOf(CALL_ID);
    if (idAt !== -1) {
      if (!/^[A-Za-z0-9]+$/.test(name.slice(idAt + CALL_ID.length))) {
        return undefined;
      }
      name = name.slice(0, idAt);
    }
    const open = argsAt + ARGS.length;
    if (text[open] !== "{") return undefined;
    const end = jsonValueEnd(text, open);
    if (end === -1) return undefined;
    const call = callFrom(
      name,
      parseJson(text.slice(open, end)),
      tools,
      text.slice(begin, end),
    );
    if (!call) return undefined;
    calls.push(call);
    pos = skipSpace(text, end);
  }
  return calls.length > 0 ? calls : undefined;
}

/** The calls in `text` when all of it is Mistral calls, else undefined. */
export function recoverMistralCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  const pos = skipSpace(text, lead.length);
  if (!text.startsWith(MARK, pos)) return undefined;
  const after = skipSpace(text, pos + MARK.length);
  const calls =
    text[after] === "["
      ? parseArray(text, pos, tools)
      : parseArgsForm(text, pos, tools);
  return calls ? { lead, calls } : undefined;
}

/** A call in the v11 layout, for round-trip tests. */
export function renderMistralCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${MARK}${call.name}${ARGS}${JSON.stringify(call.arguments)}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class MistralRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, MARK], recoverMistralCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverMistralFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new MistralRecovery(tools), text);
}
