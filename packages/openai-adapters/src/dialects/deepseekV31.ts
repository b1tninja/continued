/**
 * The `deepseek-v31` dialect: DeepSeek V3.1 writes its calls between special
 * tokens, the arguments as a JSON object,
 *
 *   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"city": "Paris"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * (fullwidth bar U+FF5C, lower one-eighth block U+2581), several calls being
 * several `<｜tool▁call▁begin｜>...<｜tool▁call▁end｜>` groups in one block.
 *
 * Source, read 2026-11-10: https://huggingface.co/deepseek-ai/DeepSeek-V3.1/
 * blob/main/tokenizer_config.json (chat_template): an assistant message with
 * tool calls renders `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>` + name +
 * `<｜tool▁sep｜>` + arguments (the JSON string) + `<｜tool▁call▁end｜>`, the
 * next calls without the first token, then `<｜tool▁calls▁end｜>`. This is not
 * the R1 layout (`function<｜tool▁sep｜>NAME` and a json code fence), which is
 * not built: its template was not read. V3.2 and later use DSML (`dsml`).
 *
 * Opt-in; for a self-hosted server that returns the tokens as content.
 *
 * Strict. The whole reply is one block (an opening `<think>` block is kept as
 * text) of one or more calls, each a declared tool and a JSON object that fits
 * its schema. Prose before or after, a missing end token, or any bad call
 * leaves the reply as text.
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
import { isObject, parseJson } from "./jsonText.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const BEGIN = "<｜tool▁calls▁begin｜>";
const END = "<｜tool▁calls▁end｜>";
const CALL_BEGIN = "<｜tool▁call▁begin｜>";
const CALL_END = "<｜tool▁call▁end｜>";
const SEP = "<｜tool▁sep｜>";

/** The calls in `text` when all of it is one V3.1 block, else undefined. */
export function recoverDeepseekV31Calls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const lead = leadingThink(text);
  const pos = skipSpace(text, lead.length);
  if (!text.startsWith(BEGIN, pos)) return undefined;
  let at = pos + BEGIN.length;
  const calls: RecoveredCall[] = [];
  while (text.startsWith(CALL_BEGIN, at)) {
    const close = text.indexOf(CALL_END, at);
    const sep = text.indexOf(SEP, at);
    if (close === -1 || sep === -1 || sep > close) return undefined;
    const name = text.slice(at + CALL_BEGIN.length, sep);
    const args = parseJson(text.slice(sep + SEP.length, close));
    const tool = tools.find((t) => t.name === name);
    if (!tool || !isObject(args)) return undefined;
    const call = fittedCall(
      tool,
      args,
      text.slice(at, close + CALL_END.length),
    );
    if (!call) return undefined;
    calls.push(call);
    at = close + CALL_END.length;
  }
  if (calls.length === 0 || !text.startsWith(END, at)) return undefined;
  return skipSpace(text, at + END.length) < text.length
    ? undefined
    : { lead, calls };
}

/** A call as the template writes it, for round-trip tests. */
export function renderDeepseekV31Call(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${BEGIN}${CALL_BEGIN}${call.name}${SEP}${JSON.stringify(call.arguments)}${CALL_END}${END}`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class DeepseekV31Recovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [THINK_OPEN, BEGIN], recoverDeepseekV31Calls);
  }
}

/** One-shot form for a complete reply. */
export function recoverDeepseekV31FromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new DeepseekV31Recovery(tools), text);
}
