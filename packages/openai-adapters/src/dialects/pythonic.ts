/**
 * The `pythonic` dialect (plans/tool-dialects.md): a tool call written in
 * Python call syntax, as Nova 2 Lite did with `present_plan(title="...",
 * decisions=[...])` instead of making the call (H13). Llama 4 and Olmo 3 write
 * this form natively.
 *
 * Recovery is the strictest of the dialects, because Python calls look like
 * prose and code. A call is recovered only when: the call starts a line, in
 * column 0, outside a code fence; the callee is exactly the name of a tool in
 * the request; every argument is a keyword argument whose name the schema
 * declares and whose value has the type the schema asks for; every required
 * argument is present; and the held text is nothing but such calls. Values are
 * read by a small parser over Python literals (strings, numbers, True, False,
 * None, lists, tuples, dicts with string keys). Nothing is ever evaluated.
 */
import type { DialectTool, RecoveredCall, RecoveryEvent } from "./qwenXml.js";

const MAX_DEPTH = 20;

class Fail extends Error {}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "0": "\0",
};

const WORD_VALUES: Record<string, unknown> = {
  True: true,
  False: false,
  None: null,
  true: true,
  false: false,
  null: null,
};

class Literals {
  pos: number;
  constructor(
    readonly src: string,
    start: number,
  ) {
    this.pos = start;
  }

  ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  peek(): string | undefined {
    return this.src[this.pos];
  }

  expect(ch: string): void {
    this.ws();
    if (this.src[this.pos] !== ch) throw new Fail(`expected ${ch}`);
    this.pos++;
  }

  ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Fail("expected a name");
    this.pos += m[0].length;
    return m[0];
  }

  string(): string {
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") throw new Fail("expected a string");
    // Triple quotes are not accepted: rare in calls and ambiguous.
    if (this.src.startsWith(quote.repeat(3), this.pos)) {
      throw new Fail("triple-quoted string");
    }
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) throw new Fail("unterminated string");
      const ch = this.src[this.pos++];
      if (ch === quote) return out;
      if (ch === "\n") throw new Fail("newline in string");
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.src[this.pos++];
      if (esc in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[esc];
      } else if (
        esc === "u" &&
        /^[0-9a-fA-F]{4}$/.test(this.src.slice(this.pos, this.pos + 4))
      ) {
        out += String.fromCharCode(
          parseInt(this.src.slice(this.pos, this.pos + 4), 16),
        );
        this.pos += 4;
      } else {
        throw new Fail("unknown escape");
      }
    }
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Fail("too deep");
    this.ws();
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === "[") return this.sequence("]", depth);
    if (ch === "(") return this.sequence(")", depth);
    if (ch === "{") return this.dict(depth);
    const rest = this.src.slice(this.pos);
    const num = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
    if (num) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_]+/.exec(rest);
    if (word && word[0] in WORD_VALUES) {
      this.pos += word[0].length;
      return WORD_VALUES[word[0]];
    }
    throw new Fail("not a literal");
  }

  sequence(close: string, depth: number): unknown[] {
    this.pos++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === close) {
        this.pos++;
        return out;
      }
      out.push(this.value(depth + 1));
      this.ws();
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== close) throw new Fail("expected , or close");
    }
  }

  dict(depth: number): Record<string, unknown> {
    this.pos++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.peek() === "}") {
        this.pos++;
        return out;
      }
      const key = this.value(depth + 1);
      if (typeof key !== "string") throw new Fail("non-string key");
      if (key in out) throw new Fail("repeated key");
      this.expect(":");
      out[key] = this.value(depth + 1);
      this.ws();
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "}") throw new Fail("expected , or }");
    }
  }
}

type Schema = {
  properties?: Record<string, { type?: string | string[] } | undefined>;
  required?: string[];
};

function typeFits(
  value: unknown,
  type: string | string[] | undefined,
): boolean {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0) return true;
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return !!value && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

/** One call at `at`, or undefined when it is not a complete valid call. */
function parseCall(
  text: string,
  at: number,
  tools: DialectTool[],
): { call: RecoveredCall; end: number } | undefined {
  try {
    const lit = new Literals(text, at);
    const name = lit.ident();
    const tool = tools.find((t) => t.name === name);
    if (!tool || lit.peek() !== "(") return undefined;
    lit.pos++;
    const schema: Schema =
      tool.parameters && typeof tool.parameters === "object"
        ? (tool.parameters as Schema)
        : {};
    const args: Record<string, unknown> = {};
    for (;;) {
      lit.ws();
      if (lit.peek() === ")") {
        lit.pos++;
        break;
      }
      const key = lit.ident();
      lit.expect("=");
      const value = lit.value(0);
      if (key in args) return undefined;
      if (schema.properties && !(key in schema.properties)) return undefined;
      if (!typeFits(value, schema.properties?.[key]?.type)) return undefined;
      args[key] = value;
      lit.ws();
      if (lit.peek() === ",") lit.pos++;
      else if (lit.peek() !== ")") return undefined;
    }
    for (const key of schema.required ?? []) {
      if (!(key in args)) return undefined;
    }
    return {
      call: { name: tool.name, arguments: args, raw: text.slice(at, lit.pos) },
      end: lit.pos,
    };
  } catch (e) {
    if (e instanceof Fail) return undefined;
    throw e;
  }
}

/** The calls in `text` when all of it is calls and whitespace, else undefined. */
export function recoverPythonicCalls(
  text: string,
  tools: DialectTool[],
): RecoveredCall[] | undefined {
  const calls: RecoveredCall[] = [];
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (at >= text.length) break;
    const one = parseCall(text, at, tools);
    if (!one) return undefined;
    calls.push(one.call);
    at = one.end;
  }
  return calls.length > 0 ? calls : undefined;
}

function pyLiteral(v: unknown): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as object)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`)
      .join(", ")}}`;
  }
  throw new Error("not a literal");
}

/** A call in Python syntax, for round-trip tests. */
export function renderPythonicCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `${call.name}(${Object.entries(call.arguments)
    .map(([k, v]) => `${k}=${pyLiteral(v)}`)
    .join(", ")})`;
}

/**
 * Stream-safe recovery for one text block. A call can only begin a line, so
 * the parser decides at each line start: if the line begins with `NAME(` for
 * a tool (or could still become that), it is held to the end of the block;
 * any other line is released at once. A held span is parsed at `end` and is
 * either calls (not shown) or released unchanged. Chunk boundaries do not
 * change the result.
 */
export class PythonicRecovery {
  private shown = "";
  private pending = "";
  private held: string | undefined;
  private atLineStart = true;
  private readonly openers: string[];

  constructor(private readonly tools: DialectTool[]) {
    this.openers = tools.map((t) => `${t.name}(`);
  }

  private release(out: RecoveryEvent[], text: string): void {
    if (!text) return;
    this.shown += text;
    out.push({ type: "text", text });
  }

  private inFence(): boolean {
    return (this.shown.split("```").length - 1) % 2 === 1;
  }

  push(chunk: string): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.held !== undefined) {
      this.held += chunk;
      return out;
    }
    let buffer = this.pending + chunk;
    this.pending = "";
    while (buffer) {
      if (!this.atLineStart) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) {
          this.release(out, buffer);
          return out;
        }
        this.release(out, buffer.slice(0, nl + 1));
        buffer = buffer.slice(nl + 1);
        this.atLineStart = true;
        continue;
      }
      if (!this.inFence()) {
        if (this.openers.some((o) => buffer.startsWith(o))) {
          this.held = buffer;
          return out;
        }
        if (this.openers.some((o) => o.startsWith(buffer))) {
          this.pending = buffer; // could still become an opener
          return out;
        }
      }
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        this.release(out, buffer);
        this.atLineStart = false;
        return out;
      }
      this.release(out, buffer.slice(0, nl + 1));
      buffer = buffer.slice(nl + 1);
    }
    return out;
  }

  end(): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.held !== undefined) {
      const calls = recoverPythonicCalls(this.held, this.tools);
      if (calls) {
        for (const call of calls) out.push({ type: "call", call });
      } else {
        this.release(out, this.held);
      }
      this.held = undefined;
    }
    this.release(out, this.pending);
    this.pending = "";
    this.atLineStart = true;
    return out;
  }
}

/** One-shot form for a complete reply. */
export function recoverPythonicFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  const parser = new PythonicRecovery(tools);
  const events = [...parser.push(text), ...parser.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}
