/**
 * The `deepseek-r1` dialect: the fenced layout that DeepSeek's chat templates
 * for R1 and V3-0324 write for a call, the arguments as a JSON object in a
 * ```json code fence after `function` and the tool name,
 *
 *   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
 *   ```json
 *   {"city": "Paris"}
 *   ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * (fullwidth bar U+FF5C, lower one-eighth block U+2581), several calls being
 * several `<｜tool▁call▁begin｜>...<｜tool▁call▁end｜>` groups in one block,
 * each after the first on its own line.
 *
 * Sources, read 2026-11-10 (all three agree on the layout):
 * - https://huggingface.co/deepseek-ai/DeepSeek-R1/raw/main/tokenizer_config.json
 *   and .../DeepSeek-V3-0324/raw/main/tokenizer_config.json (chat_template): an
 *   assistant message with tool calls renders `<｜tool▁calls▁begin｜>`, then per
 *   call `<｜tool▁call▁begin｜>` + type + `<｜tool▁sep｜>` + name + "\n```json\n"
 *   + arguments + "\n```" + `<｜tool▁call▁end｜>`, then `<｜tool▁calls▁end｜>`.
 *   Those templates never put the tool list in the prompt, so they do not tell
 *   the model to write this; they only show it in the history.
 * - https://github.com/vllm-project/vllm/blob/main/examples/
 *   tool_chat_template_deepseekr1.jinja (adapted from SGLang's template of the
 *   same name) tells the model to "use the following format" and gives
 *   `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>FUNCTION_NAME`
 *   with the json fence and `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
 *   tool_chat_template_deepseekv3.jinja does the same for V3-0324.
 * - vLLM's `deepseek_v3` tool parser (vllm/tool_parsers/deepseekv3_tool_parser.py)
 *   and SGLang's deepseekv3 detector read it with
 *   `<｜tool▁call▁begin｜>(type)<｜tool▁sep｜>(name)\n```json\n(args)\n```<｜tool▁call▁end｜>`;
 *   vLLM's docs pair `deepseek_v3` with V3-0324 and R1-0528. V3.1 and later use
 *   other layouts (`deepseek-v31`, `dsml`).
 *
 * Opt-in; for a self-hosted server that returns the tokens as content. The
 * original R1 was not trained for tools (its card shows no tool format; R1-0528
 * claims "enhanced support for function calling" without describing one), so
 * what a given model writes when asked is not established by these sources.
 *
 * Strict, like `deepseek-v31`. The whole reply is one block (an opening
 * `<think>` block is kept as text) of one or more calls whose type is
 * `function`, each a declared tool and a JSON object that fits its schema; a
 * trailing end-of-sentence token is allowed. Prose before or after, a missing
 * end token, or any bad call leaves the reply as text.
 */
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
  THINK_OPEN,
} from "./heldRecovery.js";
import { isObject, parseJson } from "./jsonText.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";
import { fittedCall } from "./schemaCheck.js";

const BEGIN = "<｜tool▁calls▁begin｜>";
const END = "<｜tool▁calls▁end｜>";
const CALL_BEGIN = "<｜tool▁call▁begin｜>";
const CALL_END = "<｜tool▁call▁end｜>";
const SEP = "<｜tool▁sep｜>";
const EOS = "<｜end▁of▁sentence｜>";
const TYPE = "function";
const FENCE_OPEN = "\n```json\n";
const FENCE_CLOSE = "\n```";

/**
 * One call at `at` (which starts with CALL_BEGIN): the call and where it ends,
 * or undefined. Every search is bounded by the call's own end marker, so the
 * whole block is read once.
 */
function parseCall(
  text: string,
  at: number,
  tools: DialectTool[],
): { call: RecoveredCall; end: number } | undefined {
  const close = text.indexOf(CALL_END, at);
  if (close === -1) return undefined;
  const typeEnd = at + CALL_BEGIN.length + TYPE.length;
  if (!text.startsWith(TYPE + SEP, at + CALL_BEGIN.length)) return undefined;
  const nameStart = typeEnd + SEP.length;
  const fence = text.indexOf(FENCE_OPEN, nameStart);
  if (fence === -1 || fence >= close) return undefined;
  const argsStart = fence + FENCE_OPEN.length;
  const argsEnd = close - FENCE_CLOSE.length;
  if (argsEnd < argsStart || !text.startsWith(FENCE_CLOSE, argsEnd)) {
    return undefined;
  }
  const name = text.slice(nameStart, fence);
  const tool = tools.find((t) => t.name === name);
  const args = parseJson(text.slice(argsStart, argsEnd));
  if (!tool || !isObject(args)) return undefined;
  const end = close + CALL_END.length;
  const call = fittedCall(tool, args, text.slice(at, end));
  return call ? { call, end } : undefined;
}

/** The calls in `text` when all of it is one R1-layout block, else undefined. */
export function recoverDeepseekR1Calls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  const pos = skipSpace(text, lead.length);
  if (!text.startsWith(BEGIN, pos)) return undefined;
  const calls: RecoveredCall[] = [];
  let at = skipSpace(text, pos + BEGIN.length);
  while (text.startsWith(CALL_BEGIN, at)) {
    const one = parseCall(text, at, tools);
    if (!one) return undefined;
    calls.push(one.call);
    at = skipSpace(text, one.end);
  }
  if (calls.length === 0 || !text.startsWith(END, at)) return undefined;
  at = skipSpace(text, at + END.length);
  if (text.startsWith(EOS, at)) at = skipSpace(text, at + EOS.length);
  return at < text.length ? undefined : { lead, calls };
}

/** A call as the templates write it, for round-trip tests. */
export function renderDeepseekR1Call(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${CALL_BEGIN}${TYPE}${SEP}${call.name}${FENCE_OPEN}${JSON.stringify(call.arguments)}${FENCE_CLOSE}${CALL_END}`;
}

/** Several calls as one block, the first after the begin token, the rest on new lines. */
export function renderDeepseekR1Calls(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  return `${BEGIN}${calls.map(renderDeepseekR1Call).join("\n")}${END}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class DeepseekR1Recovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, BEGIN], recoverDeepseekR1Calls);
  }
}

/** One-shot form for a complete reply. */
export function recoverDeepseekR1FromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new DeepseekR1Recovery(tools), text);
}
