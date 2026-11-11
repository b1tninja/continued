/**
 * The `qwen-xml` dialect (plans/tool-dialects.md): Qwen3-Coder's tool call
 * markup,
 *
 *   <tool_call>
 *   <function=NAME>
 *   <parameter=KEY>
 *   value
 *   </parameter>
 *   </function>
 *   </tool_call>
 *
 * This file renders a call in that form (for round-trip tests and, later, a
 * render path) and recovers calls from text a model wrote instead of making
 * them. Recovery is deliberately strict: a call is accepted only when the
 * whole held span parses, the tool exists, every argument is declared by its
 * schema and every required one is present. Anything else stays text.
 */

import { coerceString, repairNote } from "./schemaCheck.js";

export interface DialectTool {
  name: string;
  /** JSON schema of the arguments, when known. */
  parameters?: unknown;
}

export interface RecoveredCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The exact source span, for logs. */
  raw: string;
  /** What was changed to make the call fit its schema; absent when nothing was. */
  repairs?: RepairNote[];
}

/**
 * A string value made into the literal the schema declares (`"10"` to `10`
 * for an integer): the one repair recovery makes, listed so a bench or a log
 * can count it. Kept on the recovered call; nothing downstream reads it yet.
 */
export interface RepairNote {
  kind: "string-to-literal";
  /** The argument name. */
  argument: string;
  /** The text the model wrote. */
  from: string;
  /** The value the call carries instead. */
  to: unknown;
}

export type RecoveryEvent =
  { type: "text"; text: string } | { type: "call"; call: RecoveredCall };

const CALL_OPEN = "<tool_call>";
const FUNCTION_OPEN = "<function=";
const MARKERS = [CALL_OPEN, FUNCTION_OPEN];

type Schema = {
  properties?: Record<string, { type?: string | string[] } | undefined>;
  required?: string[];
};

function schemaOf(tool: DialectTool): Schema {
  return tool.parameters && typeof tool.parameters === "object"
    ? (tool.parameters as Schema)
    : {};
}

/**
 * One value as the tool's schema declares it; undefined when it does not fit.
 * Text is all a Qwen value is, so a string-typed (or untyped) parameter keeps
 * it as written and any other type goes through the shared `coerceString`
 * (surrounding whitespace is markup layout here, not part of the literal).
 */
function coerce(
  value: string,
  type: string | string[] | undefined,
): { value: unknown; repaired: boolean } | undefined {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0 || types.includes("string")) {
    return { value, repaired: false };
  }
  const coerced = coerceString(value.trim(), type);
  return coerced === undefined ? undefined : { value: coerced, repaired: true };
}

const OPEN_RE = /(?:<tool_call>\s*)?<function=([^>\s]+)>/y;
const PARAM_OPEN_RE = /<parameter=([^>\s]+)>\n?/y;
const PARAM_CLOSE = "</parameter>";
const FUNCTION_CLOSE = "</function>";
const CALL_CLOSE_RE = /\s*<\/tool_call>/y;
/** Backtracking steps one recovery may take before it gives up (stays text). */
const STEP_BUDGET = 20000;

/**
 * Whether a candidate value, text[from, to), is balanced where it looks like
 * markup: every `</parameter>` inside it that would close a parameter
 * structurally closes a `<parameter=` opened inside it. A value that quotes a
 * whole call is balanced; one that swallowed the next parameter's boundary
 * (turning an invalid call into a valid one by folding it into a string) is
 * not.
 */
function quotesBalanced(text: string, from: number, to: number): boolean {
  const re = /<parameter=[^>\s]*>|<\/parameter>/g;
  const value = text.slice(from, to);
  let depth = 0;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (m[0] !== PARAM_CLOSE) {
      depth++;
      continue;
    }
    let k = from + m.index + PARAM_CLOSE.length;
    while (k < text.length && /\s/.test(text[k])) k++;
    const structural =
      text.startsWith("<parameter=", k) || text.startsWith(FUNCTION_CLOSE, k);
    if (structural && --depth < 0) return false;
  }
  return true;
}

/**
 * Parse `text` from `at` as calls and whitespace to its end, or undefined.
 *
 * A value may itself contain the closing tags (a file that quotes `</function>`),
 * so the first closing tag is not taken on trust: a `</parameter>` closes a
 * value only when whitespace and then `<parameter=` or `</function>` follow,
 * and a `</function>` closes a call only when what follows parses as the rest
 * of the reply. Candidate closers are tried nearest first and one that leaves
 * a schema-invalid value (an undeclared or repeated key, a value that does not
 * fit its type) is passed over for a later one, so the reading that yields a
 * valid call wins and two calls are never merged into one: every call must
 * still be closed by its own `</function>` and the whole reply must parse.
 */
function parseCalls(
  text: string,
  at: number,
  tools: DialectTool[],
  budget: { steps: number },
): RecoveredCall[] | undefined {
  while (at < text.length && /\s/.test(text[at])) at++;
  if (at >= text.length) return [];
  OPEN_RE.lastIndex = at;
  const open = OPEN_RE.exec(text);
  if (!open) return undefined;
  const tool = tools.find((t) => t.name === open[1]);
  if (!tool) return undefined;
  const schema = schemaOf(tool);
  const properties = schema.properties;
  const start = at;

  const params = (
    pos: number,
    args: Record<string, unknown>,
    repairs: RepairNote[],
  ): RecoveredCall[] | undefined => {
    if (++budget.steps > STEP_BUDGET) return undefined;
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text.startsWith(FUNCTION_CLOSE, pos)) {
      for (const key of schema.required ?? []) {
        if (!(key in args)) return undefined;
      }
      let end = pos + FUNCTION_CLOSE.length;
      CALL_CLOSE_RE.lastIndex = end;
      if (CALL_CLOSE_RE.exec(text)) end = CALL_CLOSE_RE.lastIndex;
      const rest = parseCalls(text, end, tools, budget);
      if (!rest) return undefined;
      return [
        {
          name: tool.name,
          arguments: args,
          raw: text.slice(start, end),
          ...(repairs.length > 0 ? { repairs } : {}),
        },
        ...rest,
      ];
    }
    PARAM_OPEN_RE.lastIndex = pos;
    const p = PARAM_OPEN_RE.exec(text);
    if (!p) return undefined;
    const key = p[1];
    if (key in args) return undefined; // a repeated key is ambiguous
    if (properties && !(key in properties)) return undefined;
    const valueStart = PARAM_OPEN_RE.lastIndex;
    for (
      let j = text.indexOf(PARAM_CLOSE, valueStart);
      j !== -1;
      j = text.indexOf(PARAM_CLOSE, j + 1)
    ) {
      const after = j + PARAM_CLOSE.length;
      let k = after;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (
        !text.startsWith("<parameter=", k) &&
        !text.startsWith(FUNCTION_CLOSE, k)
      ) {
        continue; // quoted text, not the end of the value
      }
      if (!quotesBalanced(text, valueStart, j)) continue;
      const raw = text.slice(valueStart, j);
      const written = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      const fit = coerce(written, properties?.[key]?.type);
      if (fit === undefined) continue;
      const done = params(
        after,
        { ...args, [key]: fit.value },
        fit.repaired
          ? [...repairs, repairNote(key, written, fit.value)]
          : repairs,
      );
      if (done) return done;
      if (budget.steps > STEP_BUDGET) return undefined;
    }
    return undefined;
  };
  return params(open.index + open[0].length, {}, []);
}

/**
 * The calls in `text` when the whole of it is calls and whitespace, else
 * undefined. A reply that mixes a call with prose after it is not recovered:
 * the call may have been an example.
 */
export function recoverQwenXmlCalls(
  text: string,
  tools: DialectTool[],
): RecoveredCall[] | undefined {
  const calls = parseCalls(text, 0, tools, { steps: 0 });
  return calls && calls.length > 0 ? calls : undefined;
}

/** A call as the Qwen3-Coder template writes it. */
export function renderQwenXmlCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  const params = Object.entries(call.arguments)
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `<parameter=${k}>\n${text}\n</parameter>\n`;
    })
    .join("");
  return `<tool_call>\n<function=${call.name}>\n${params}</function>\n</tool_call>`;
}

/** Length of the longest proper prefix of any marker that `text` ends with. */
function trailingMarkerPrefix(text: string): number {
  let best = 0;
  for (const marker of MARKERS) {
    const max = Math.min(text.length, marker.length - 1);
    for (let n = max; n > best; n--) {
      if (marker.startsWith(text.slice(-n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

/**
 * Whether a marker at `at` in `text` begins a call rather than quoting one:
 * not right after a backtick, and not inside a code fence.
 */
function startsCall(text: string, at: number): boolean {
  if (at > 0 && text[at - 1] === "`") return false;
  const before = text.slice(0, at);
  const fences = before.split("```").length - 1;
  return fences % 2 === 0;
}

/**
 * Stream-safe recovery for one text block. `push` takes each text delta and
 * returns what can be shown now. Once a marker that begins a call is seen,
 * everything from it on is held until `end`, where it is either parsed as
 * calls (and not shown) or released unchanged as text. A trailing fragment
 * that could still become a marker is held too, so a split marker never
 * leaks. Chunk boundaries do not change the result.
 */
export class QwenXmlRecovery {
  private shown = ""; // text already released, for fence and backtick checks
  private pending = ""; // possible start of a marker, or text not yet judged
  private held: string | undefined; // from the first call marker on

  constructor(private readonly tools: DialectTool[]) {}

  private release(out: RecoveryEvent[], text: string): void {
    if (!text) return;
    this.shown += text;
    out.push({ type: "text", text });
  }

  push(chunk: string): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.held !== undefined) {
      this.held += chunk;
      return out;
    }
    let buffer = this.pending + chunk;
    this.pending = "";
    for (;;) {
      let at = -1;
      let markerLength = 0;
      for (const marker of MARKERS) {
        const i = buffer.indexOf(marker);
        if (i !== -1 && (at === -1 || i < at)) {
          at = i;
          markerLength = marker.length;
        }
      }
      if (at === -1) {
        const keep = trailingMarkerPrefix(buffer);
        this.pending = keep ? buffer.slice(-keep) : "";
        this.release(out, keep ? buffer.slice(0, -keep) : buffer);
        return out;
      }
      if (startsCall(this.shown + buffer, this.shown.length + at)) {
        this.release(out, buffer.slice(0, at));
        this.held = buffer.slice(at);
        return out;
      }
      // Quoted, not a call: it is text; look for the next marker after it.
      this.release(out, buffer.slice(0, at + markerLength));
      buffer = buffer.slice(at + markerLength);
    }
  }

  isHolding(): boolean {
    return this.held !== undefined;
  }

  /** The end of the text block: parse what was held, release the rest. */
  end(): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.held !== undefined) {
      const calls = recoverQwenXmlCalls(this.held, this.tools);
      if (calls) {
        for (const call of calls) out.push({ type: "call", call });
      } else {
        this.release(out, this.held);
      }
      this.held = undefined;
    }
    this.release(out, this.pending);
    this.pending = "";
    return out;
  }
}

/** One-shot form for a complete reply (the non-streaming path). */
export function recoverQwenXmlFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  const parser = new QwenXmlRecovery(tools);
  const events = [...parser.push(text), ...parser.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}

/** The setting that turns recovery on, off by default. */
export const RECOVER_TEXT_TOOL_CALLS_FIELD =
  "x_continue_recover_text_tool_calls";
export const RECOVER_TEXT_TOOL_CALLS_ENV = "CONTINUE_RECOVER_TEXT_TOOL_CALLS";

/**
 * Whether to recover Qwen XML calls from text for this request: the request
 * field or the environment variable names `qwen-xml`, and the model is a Qwen
 * one. Off unless asked for.
 */
export function qwenXmlRecoveryEnabled(
  model: string,
  body?: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!/qwen/i.test(model)) return false;
  const asked =
    (body as Record<string, unknown> | undefined)?.[
      RECOVER_TEXT_TOOL_CALLS_FIELD
    ] ?? env[RECOVER_TEXT_TOOL_CALLS_ENV];
  return asked === "qwen-xml" || asked === true;
}
