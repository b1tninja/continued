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

/** One value as the tool's schema declares it; undefined when it does not fit. */
function coerce(value: string, type: string | string[] | undefined): unknown {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0 || types.includes("string")) {
    // A parameter that may be a string is one: no guessing.
    return value;
  }
  const trimmed = value.trim();
  if (types.includes("integer") || types.includes("number")) {
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (types.includes("number") || Number.isInteger(n)) return n;
    }
  }
  if (types.includes("boolean")) {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  if (types.includes("array") || types.includes("object")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const isArray = Array.isArray(parsed);
      const isObject = !!parsed && typeof parsed === "object" && !isArray;
      if (
        (isArray && types.includes("array")) ||
        (isObject && types.includes("object"))
      ) {
        return parsed;
      }
    } catch {
      // falls through to undefined
    }
  }
  return undefined;
}

const FUNCTION_RE =
  /(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/y;
const PARAM_RE = /\s*<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/y;

/** One call at `at`, or undefined when it is not a complete valid call. */
function parseOneCall(
  text: string,
  at: number,
  tools: DialectTool[],
): { call: RecoveredCall; end: number } | undefined {
  FUNCTION_RE.lastIndex = at;
  const m = FUNCTION_RE.exec(text);
  if (!m) return undefined;
  const tool = tools.find((t) => t.name === m[1]);
  if (!tool) return undefined;
  const schema = schemaOf(tool);
  const properties = schema.properties;
  const args: Record<string, unknown> = {};
  const body = m[2];
  let pos = 0;
  for (;;) {
    PARAM_RE.lastIndex = pos;
    const p = PARAM_RE.exec(body);
    if (!p) break;
    pos = PARAM_RE.lastIndex;
    const key = p[1];
    if (key in args) return undefined; // a repeated key is ambiguous
    if (properties && !(key in properties)) return undefined;
    const value = coerce(p[2], properties?.[key]?.type);
    if (value === undefined) return undefined;
    args[key] = value;
  }
  if (body.slice(pos).trim() !== "") return undefined; // leftover text
  for (const key of schema.required ?? []) {
    if (!(key in args)) return undefined;
  }
  return {
    call: { name: tool.name, arguments: args, raw: m[0] },
    end: at + m[0].length,
  };
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
  const calls: RecoveredCall[] = [];
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (at >= text.length) break;
    const one = parseOneCall(text, at, tools);
    if (!one) return undefined;
    calls.push(one.call);
    at = one.end;
  }
  return calls.length > 0 ? calls : undefined;
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
