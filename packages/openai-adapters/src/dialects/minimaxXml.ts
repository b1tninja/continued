/**
 * The `minimax-xml` dialect: MiniMax-M2 and M2.5 write calls as XML,
 *
 *   <minimax:tool_call>
 *   <invoke name="get_weather">
 *   <parameter name="city">Paris</parameter>
 *   </invoke>
 *   </minimax:tool_call>
 *
 * Sources, read 2026-11-10: the MiniMax-M2 chat template
 * (https://huggingface.co/MiniMaxAI/MiniMax-M2/blob/main/chat_template.jinja:
 * `<minimax:tool_call>`, one `<invoke name="...">` per call with a
 * `<parameter name="...">` per argument, a string value verbatim and any other
 * value as JSON) and the vendor's tool-calling guide
 * (.../docs/tool_calling_guide.md, "Model Output Format" and "Manually Parsing
 * Tool Call Results"). MiniMax-M2 and M2.5 on Bedrock Converse returned
 * structured calls, so no text form was captured: every corpus fixture is
 * synthesised and the parser is opt-in (`toolDialect: minimax-xml`).
 *
 * Strict. The whole reply must be an optional leading `<think>` block (kept
 * as text) and then only `<minimax:tool_call>` blocks, each holding one or
 * more `<invoke name="NAME">` with a declared tool and `<parameter
 * name="KEY">` values. A value for a string (or undeclared) argument is taken
 * verbatim; any other declared type must be JSON of that type. Arguments must
 * fit the schema; a duplicate key refuses the call. Names are double-quoted,
 * as the template writes them. M2's generation prompt ends inside `<think>`, so
 * a server without a reasoning parser sends `reasoning</think>` first; that
 * shape does not start with a marker and is not recovered.
 */
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import { typedValue } from "./glmXml.js";
import { fittedCall } from "./schemaCheck.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const OPEN = "<minimax:tool_call>";
const CLOSE = "</minimax:tool_call>";
const INVOKE = '<invoke name="';
const INVOKE_CLOSE = "</invoke>";
const PARAM = '<parameter name="';
const PARAM_CLOSE = "</parameter>";

/** `"NAME">` at `at`: the name and the index after the `>`. */
function quotedName(
  text: string,
  at: number,
): { name: string; next: number } | undefined {
  const end = text.indexOf('">', at);
  if (end === -1) return undefined;
  const name = text.slice(at, end);
  return name && !/[<>"\s]/.test(name) ? { name, next: end + 2 } : undefined;
}

/** Index of the `</parameter>` that really ends a value starting at `from`. */
function valueEnd(text: string, from: number): number {
  for (let i = text.indexOf(PARAM_CLOSE, from); i !== -1;) {
    const next = skipSpace(text, i + PARAM_CLOSE.length);
    if (text.startsWith(PARAM, next) || text.startsWith(INVOKE_CLOSE, next)) {
      return i;
    }
    i = text.indexOf(PARAM_CLOSE, i + 1);
  }
  return -1;
}

function parseInvoke(
  text: string,
  pos: number,
  tools: DialectTool[],
): { call: RecoveredCall; next: number } | undefined {
  const head = quotedName(text, pos + INVOKE.length);
  const tool = head && tools.find((t) => t.name === head.name);
  if (!head || !tool) return undefined;
  const args: Record<string, unknown> = {};
  let at = head.next;
  for (;;) {
    at = skipSpace(text, at);
    if (text.startsWith(INVOKE_CLOSE, at)) break;
    if (!text.startsWith(PARAM, at)) return undefined;
    const key = quotedName(text, at + PARAM.length);
    if (!key || key.name in args) return undefined;
    const end = valueEnd(text, key.next);
    if (end === -1) return undefined;
    const typed = typedValue(tool, key.name, text.slice(key.next, end));
    if (!typed.ok) return undefined;
    args[key.name] = typed.value;
    at = end + PARAM_CLOSE.length;
  }
  const next = at + INVOKE_CLOSE.length;
  const call = fittedCall(tool, args, text.slice(pos, next));
  return call ? { call, next } : undefined;
}

/** The invokes of one block starting at `pos`, and the index after it. */
function parseBlock(
  text: string,
  pos: number,
  tools: DialectTool[],
): { calls: RecoveredCall[]; next: number } | undefined {
  const calls: RecoveredCall[] = [];
  let at = pos + OPEN.length;
  for (;;) {
    at = skipSpace(text, at);
    if (text.startsWith(CLOSE, at)) break;
    if (!text.startsWith(INVOKE, at)) return undefined;
    const invoke = parseInvoke(text, at, tools);
    if (!invoke) return undefined;
    calls.push(invoke.call);
    at = invoke.next;
  }
  return calls.length > 0 ? { calls, next: at + CLOSE.length } : undefined;
}

/** The calls in `text` when all of it is MiniMax calls, else undefined. */
export function recoverMinimaxXmlCalls(
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
    calls.push(...block.calls);
    pos = block.next;
  }
  return calls.length > 0 ? { lead, calls } : undefined;
}

/** A block in the form MiniMax-M2 writes it, for round-trip tests. */
export function renderMinimaxXmlCalls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  const invokes = calls
    .map((c) => {
      const params = Object.entries(c.arguments)
        .map(([k, v]) => {
          const value = typeof v === "string" ? v : JSON.stringify(v);
          return `${PARAM}${k}">${value}${PARAM_CLOSE}\n`;
        })
        .join("");
      return `${INVOKE}${c.name}">\n${params}${INVOKE_CLOSE}\n`;
    })
    .join("");
  return `${OPEN}\n${invokes}${CLOSE}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class MinimaxXmlRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, OPEN], recoverMinimaxXmlCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverMinimaxXmlFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new MinimaxXmlRecovery(tools), text);
}
