/**
 * The `dsml` dialect: DeepSeek V3.2 and V4 write a call in "DSML" markup, with
 * the fullwidth bar U+FF5C:
 *
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="read_file">
 *   <｜DSML｜parameter name="path" string="true">src/main.ts</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * V3.2 names the block `function_calls`, V4 names it `tool_calls`; the rest is
 * the same. Sources, read 2026-11-10:
 * - https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/main/encoding/
 *   encoding_dsv32.py: the system prompt template ("You can invoke functions
 *   by writing a "<｜DSML｜function_calls>" block like the following"), the
 *   encoder (`tool_call_template`, `encode_arguments_to_dsml`: `string="true"`
 *   for a str value, `"false"` and `json.dumps` otherwise) and the reference
 *   parser `parse_tool_calls`, which requires `>\n` after the block and each
 *   invoke tag, `name="..."` then `>\n`, ` name="..." string="true|false">`,
 *   rejects a repeated parameter, and reads a `false` value as JSON.
 * - https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/
 *   encoding_dsv4.py: the same with `tool_calls_block_name = "tool_calls"`.
 *
 * Seen live: DeepSeek V3.2 on Bedrock Converse leaves the opening
 * `<｜DSML｜function_calls` in its text before a structured call (corpus
 * fixture deepseek-v32-bedrock-dsml-fragment): a fragment is never a call. This
 * parser matters for a self-hosted server that returns the markup as content.
 * Opt-in.
 *
 * Strict. The whole reply is one block (an opening `<think>` block is kept as
 * text) of one or more invokes, laid out as the reference parser requires, and
 * nothing else: no prose before or after (the reference allows prose before
 * the block; this parser does not, because it must tell a call from a quoted
 * example). A `string="true"` value is the text as written, a `string="false"`
 * value is JSON of any type; both then go through the shared schema check.
 * The tool must be declared, no parameter repeated or undeclared, none missing.
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
import { parseJson } from "./jsonText.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const DSML = "｜DSML｜";
const BLOCKS = ["function_calls", "tool_calls"];
const PARAM_OPEN = new RegExp(
  `^<${DSML}parameter name="([^"]*)" string="(true|false)">`,
);
const PARAM_CLOSE = `</${DSML}parameter>\n`;
const INVOKE_OPEN = new RegExp(`^<${DSML}invoke name="([^"]*)">\n`);
const INVOKE_CLOSE = `</${DSML}invoke>\n`;

/** One invoke at `pos`: the call and the index after it, or undefined. */
function parseInvoke(
  text: string,
  pos: number,
  tools: DialectTool[],
): { call: RecoveredCall; end: number } | undefined {
  const head = INVOKE_OPEN.exec(text.slice(pos, pos + 400));
  const tool = head && tools.find((t) => t.name === head[1]);
  if (!head || !tool) return undefined;
  let at = pos + head[0].length;
  // The encoder writes an empty line for an invoke with no parameters.
  if (text.startsWith(`\n${INVOKE_CLOSE}`, at)) at++;
  const args: Record<string, unknown> = {};
  while (!text.startsWith(INVOKE_CLOSE, at)) {
    const open = PARAM_OPEN.exec(text.slice(at, at + 400));
    if (!open || open[1] in args) return undefined;
    const valueStart = at + open[0].length;
    const close = text.indexOf(PARAM_CLOSE, valueStart);
    if (close === -1) return undefined;
    const value = text.slice(valueStart, close);
    if (open[2] === "true") {
      args[open[1]] = value;
    } else {
      const parsed = parseJson(value);
      if (parsed === undefined) return undefined;
      args[open[1]] = parsed;
    }
    at = close + PARAM_CLOSE.length;
  }
  const end = at + INVOKE_CLOSE.length;
  const call = fittedCall(tool, args, text.slice(pos, end));
  return call ? { call, end } : undefined;
}

/** The calls in `text` when all of it is one DSML block, else undefined. */
export function recoverDsmlCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  const pos = skipSpace(text, lead.length);
  const block = BLOCKS.find((b) => text.startsWith(`<${DSML}${b}>\n`, pos));
  if (!block) return undefined;
  const close = `</${DSML}${block}>`;
  let at = pos + `<${DSML}${block}>\n`.length;
  const calls: RecoveredCall[] = [];
  while (!text.startsWith(close, at)) {
    const one = parseInvoke(text, at, tools);
    if (!one) return undefined;
    calls.push(one.call);
    at = one.end;
  }
  if (calls.length === 0 || skipSpace(text, at + close.length) < text.length) {
    return undefined;
  }
  return { lead, calls };
}

/** A call as the V3.2 encoder writes it, for round-trip tests. */
export function renderDsmlCall(
  call: { name: string; arguments: Record<string, unknown> },
  block = "function_calls",
): string {
  const params = Object.entries(call.arguments)
    .map(([k, v]) => {
      const isStr = typeof v === "string";
      return `<${DSML}parameter name="${k}" string="${isStr}">${isStr ? v : JSON.stringify(v)}</${DSML}parameter>`;
    })
    .join("\n");
  return `<${DSML}${block}>\n<${DSML}invoke name="${call.name}">\n${params}\n</${DSML}invoke>\n</${DSML}${block}>`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class DsmlRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, `<${DSML}`], recoverDsmlCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverDsmlFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new DsmlRecovery(tools), text);
}
