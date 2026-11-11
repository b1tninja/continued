/**
 * The wrapper dialects: families whose text call form is "a marker, a body in
 * a grammar this package already reads, a marker". One engine
 * (`recoverWrapped`) holds the framing rules; one row per family says which
 * markers and which inner grammar (wrapperInner.ts); each family keeps its own
 * `toolDialect` value so a model can be set to it explicitly.
 *
 * The framing is strict, like every dialect here. The whole reply must be: an
 * optional leading think block (kept as text), an optional preamble marker,
 * then blocks (`open` body `close`, separated by whitespace, or `open` and a
 * body that runs to the end when the family has no close marker), then an
 * optional postamble marker, and nothing else. Prose, a fenced example, an
 * undeclared tool, a malformed body or a missing close marker leave the whole
 * reply as text. A literal close marker inside a string value is handled by
 * trying each later close marker until the body and the rest of the reply both
 * parse. Nothing is guessed and nothing is run.
 *
 * Every row was written from a primary source read on 2026-11-10: the model's
 * own chat template (Hugging Face), the vendor's documentation, or the parser
 * the vendor's own serving fork ships. No live capture of any of these
 * families exists, so every one is opt-in and its corpus fixtures are
 * synthesised.
 */
import {
  HeldBlockRecovery,
  leadingThink,
  type ParsedReply,
  recoverWhole,
  skipSpace,
} from "./heldRecovery.js";
import {
  idNameArgs,
  type InnerParser,
  jsonArray,
  jsonObject,
  keyValueCalls,
  pythonicLines,
  pythonicList,
  qwenInvoke,
  suffixedKeyValueTags,
} from "./wrapperInner.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

/** One family: its dialect name, its markers and its inner grammar. */
export interface WrapperRow {
  /** The `toolDialect` value. */
  dialect: string;
  /** Model ids a plain (not `force:`) setting applies to. */
  nameRe: RegExp;
  /** The family's own think block, kept as text when it leads the reply. */
  think?: { open: string; close: string };
  /** A marker that may precede the first block (once). */
  preamble?: string;
  open: string;
  /** Absent: the body runs to the end of the reply. */
  close?: string;
  /** A marker that may follow the last block (once). */
  postamble?: string;
  /** The most blocks a reply may hold; absent means any number. */
  maxBlocks?: number;
  inner: InnerParser;
}

const HY3_SUFFIX = ":opensource";

/**
 * The rows. Each comment is the source of the form and the date it was read.
 */
export const WRAPPER_ROWS: readonly WrapperRow[] = [
  {
    // IBM Granite 3.x. The 3.3 chat template (huggingface.co/ibm-granite/
    // granite-3.3-8b-instruct, tokenizer_config.json) tells the model to
    // "respond only with <|tool_call|> followed by a JSON list of tools
    // used"; vLLM's Granite parser (vllm-project/vllm v0.11.0
    // entrypoints/openai/tool_parsers/granite_tool_parser.py) and its
    // examples/tool_chat_template_granite.jinja read and write
    // `<|tool_call|>[{"name": ..., "arguments": {...}}]`. Read 2026-11-10.
    // Granite 4.0 writes <tool_call> JSON (hermes-json) and 4.2 qwen-xml.
    dialect: "granite-tokens",
    nameRe: /granite/i,
    open: "<|tool_call|>",
    inner: jsonArray({ name: "name", args: "arguments" }),
  },
  {
    // Liquid LFM2 / LFM2.5. The chat templates (huggingface.co/LiquidAI/
    // LFM2-8B-A1B and LFM2.5-24B-A2B, chat_template.jinja, render_tool_calls)
    // write `<|tool_call_start|>[name(arg=value, ...)]<|tool_call_end|>`, a
    // Python list; docs.liquid.ai/lfm/key-concepts/tool-use: "By default,
    // models generate Pythonic function calls" between those tokens. Read
    // 2026-11-10. (The JSON mode the docs mention, switched on by a system
    // prompt line, is not recovered: its exact shape is not documented.)
    dialect: "lfm-tokens",
    nameRe: /lfm|liquid/i,
    think: { open: "<think>", close: "</think>" },
    open: "<|tool_call_start|>",
    close: "<|tool_call_end|>",
    inner: pythonicList,
  },
  {
    // Tencent Hy3. The chat template (huggingface.co/tencent/Hy3,
    // chat_template.jinja) writes `<tool_calls:opensource>`, then for each
    // call `<tool_call:opensource>NAME<tool_sep:opensource>` and
    // `<arg_key:opensource>K</arg_key:opensource>` /
    // `<arg_value:opensource>V</arg_value:opensource>` pairs (a string value
    // raw, any other value as JSON), `</tool_call:opensource>`, and
    // `</tool_calls:opensource>`; vLLM's `hy_v3` parser reads the same tags.
    // Read 2026-11-10.
    dialect: "hy3-tags",
    nameRe: /hy3|hy-v3/i,
    think: { open: `<think${HY3_SUFFIX}>`, close: `</think${HY3_SUFFIX}>` },
    open: `<tool_calls${HY3_SUFFIX}>`,
    close: `</tool_calls${HY3_SUFFIX}>`,
    maxBlocks: 1,
    inner: keyValueCalls(suffixedKeyValueTags(HY3_SUFFIX)),
  },
  {
    // Upstage Solar Open. The chat template (huggingface.co/upstage/
    // Solar-Open-100B, chat_template.jinja, "Tool Call Format") has the model
    // write `<|tool_call:begin|><id><|tool_call:name|><name><|tool_call:args|>
    // <args-json-object><|tool_call:end|>` with a 10-character [a-z0-9] id,
    // after `<|tool_calls|>` and before `<|calls|>`; Upstage's vLLM fork
    // (UpstageAI/vllm v0.12.0-solar-open, solar_open_tool_parser.py) treats
    // both of those as optional and validates the id the same way. Read
    // 2026-11-10.
    dialect: "solar-tokens",
    nameRe: /solar/i,
    preamble: "<|tool_calls|>",
    open: "<|tool_call:begin|>",
    close: "<|tool_call:end|>",
    postamble: "<|calls|>",
    inner: idNameArgs({
      id: /^[a-z0-9]{10}$/,
      nameSep: "<|tool_call:name|>",
      argsSep: "<|tool_call:args|>",
    }),
  },
  {
    // Meituan LongCat-Flash. The chat template (huggingface.co/meituan-
    // longcat/LongCat-Flash-Chat, tokenizer_config.json) tells the model to
    // return `<longcat_tool_call>\n{"name": <function-name>, "arguments":
    // <args-dict>}\n</longcat_tool_call>`, one block per call, consecutive
    // blocks for parallel calls; its reasoning sits in `<longcat_think>`.
    // vLLM's `longcat` parser matches the same tags. Read 2026-11-10.
    dialect: "longcat-json",
    nameRe: /longcat/i,
    think: { open: "<longcat_think>", close: "</longcat_think>" },
    open: "<longcat_tool_call>",
    close: "</longcat_tool_call>",
    inner: jsonObject({ name: "name", args: "arguments" }),
  },
  {
    // AI2 Olmo 3. The chat template (huggingface.co/allenai/Olmo-3-7B-
    // Instruct, chat_template.jinja) writes `<function_calls>` + calls as
    // `name(key=<json value>, ...)`, one per line, + `</function_calls>`;
    // vLLM's docs (features/tool_calling.md, "Olmo 3 Models") describe the
    // same wrapper with newline-delimited pythonic calls. Read 2026-11-10.
    dialect: "olmo-function-calls",
    nameRe: /olmo/i,
    open: "<function_calls>",
    close: "</function_calls>",
    maxBlocks: 1,
    inner: pythonicLines,
  },
  {
    // ByteDance Seed-OSS. The chat template (huggingface.co/ByteDance-Seed/
    // Seed-OSS-36B-Instruct, chat_template.jinja) writes `<seed:tool_call>\n
    // <function=NAME>\n<parameter=KEY>value</parameter>\n</function>\n
    // </seed:tool_call>`, one function per block; reasoning sits in
    // `<seed:think>`. Read 2026-11-10.
    dialect: "seed-xml",
    nameRe: /seed/i,
    think: { open: "<seed:think>", close: "</seed:think>" },
    open: "<seed:tool_call>",
    close: "</seed:tool_call>",
    inner: qwenInvoke,
  },
  {
    // Cohere Command A / R7B. The chat template of the Hub repos is gated, so
    // the form comes from Cohere's public documentation (docs.cohere.com/docs/
    // command-a-hf, the rendered prompt and the "Action" step): "write
    // <|START_ACTION|> followed by a list of JSON-formatted tool calls, with
    // each one containing "tool_name" and "parameters" fields ... close it out
    // with <|END_ACTION|>", the example being `<|START_ACTION|> [ {"tool_call_id":
    // "0", "tool_name": ..., "parameters": {...}} ] <|END_ACTION|>` after a
    // `<|START_THINKING|>...<|END_THINKING|>` block. Read 2026-11-10. (Command
    // R and R+ of 2024 use a different, fenced form and are not covered.)
    dialect: "cohere-action",
    nameRe: /command|cohere/i,
    think: { open: "<|START_THINKING|>", close: "<|END_THINKING|>" },
    open: "<|START_ACTION|>",
    close: "<|END_ACTION|>",
    maxBlocks: 1,
    inner: jsonArray({
      name: "tool_name",
      args: "parameters",
      optional: ["tool_call_id"],
    }),
  },
];

/** The row for a dialect name, if there is one. */
export function wrapperRowFor(dialect: string): WrapperRow | undefined {
  return WRAPPER_ROWS.find((r) => r.dialect === dialect);
}

const STEP_BUDGET = 2000;

interface Frame {
  text: string;
  row: WrapperRow;
  tools: DialectTool[];
  steps: number;
}

/** The calls of the blocks from `pos` to the end of the reply, or undefined. */
function blocksFrom(
  f: Frame,
  start: number,
  left: number,
): RecoveredCall[] | undefined {
  const { text, row } = f;
  const pos = skipSpace(text, start);
  if (row.postamble && text.startsWith(row.postamble, pos)) {
    return skipSpace(text, pos + row.postamble.length) >= text.length
      ? []
      : undefined;
  }
  if (pos >= text.length) return [];
  if (left === 0 || !text.startsWith(row.open, pos)) return undefined;
  const bodyStart = pos + row.open.length;
  if (row.close === undefined) {
    const calls = row.inner(text.slice(bodyStart), f.tools);
    return calls?.map((c) => ({ ...c, raw: text.slice(pos) }));
  }
  for (
    let end = text.indexOf(row.close, bodyStart);
    end !== -1;
    end = text.indexOf(row.close, end + 1)
  ) {
    if (++f.steps > STEP_BUDGET) return undefined;
    const calls = row.inner(text.slice(bodyStart, end), f.tools);
    if (!calls) continue;
    const next = end + row.close.length;
    const more = blocksFrom(f, next, left - 1);
    if (more) {
      const raw = text.slice(pos, next);
      return [...calls.map((c) => ({ ...c, raw })), ...more];
    }
  }
  return undefined;
}

/** The calls in `text` when all of it is calls of this family, else undefined. */
export function recoverWrapped(
  text: string,
  tools: DialectTool[],
  row: WrapperRow,
): ParsedReply | undefined {
  const lead = row.think
    ? leadingThink(text, row.think.open, row.think.close)
    : "";
  let pos = skipSpace(text, lead.length);
  if (row.preamble && text.startsWith(row.preamble, pos)) {
    pos += row.preamble.length;
  }
  const calls = blocksFrom(
    { text, row, tools, steps: 0 },
    pos,
    row.maxBlocks ?? Infinity,
  );
  return calls && calls.length > 0 ? { lead, calls } : undefined;
}

/** Stream-safe recovery for one text block of a wrapper family. */
export class WrapperRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[], row: WrapperRow) {
    super(
      tools,
      [row.think?.open, row.preamble, row.open].filter(
        (m): m is string => m !== undefined,
      ),
      (text, t) => recoverWrapped(text, t, row),
    );
  }
}

/** One-shot form for a complete reply; the reply is left alone for an unknown dialect. */
export function recoverWrappedFromText(
  dialect: string,
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  const row = wrapperRowFor(dialect);
  if (!row) return { text, calls: [] };
  return recoverWhole(new WrapperRecovery(tools, row), text);
}
