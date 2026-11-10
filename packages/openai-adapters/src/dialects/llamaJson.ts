/**
 * The `llama-json` dialect (plans/live-tool-call-findings.md): Meta's Llama
 * writes a tool call as a JSON object in its reply, and Bedrock's Converse API
 * hands it over as text instead of a structured `toolUse`. Seen live on
 * 2026-11-10: Llama 3.3 70B did it on every tool prompt, Llama 4 Maverick on
 * two of eight,
 *
 *   {"type": "function", "name": "read_file", "parameters": {"path": "a"}}
 *
 * and, for two calls, a JSON array whose elements are JSON-encoded strings of
 * such objects.
 *
 * Recovery is strict, like the other dialects. The whole reply must be one
 * object, or an array of objects or of strings that each hold one object, and
 * nothing else. An object has exactly `name` and `parameters`, plus an optional
 * `type` that is "function". The name is a tool in the request; `parameters`
 * is an object whose keys the schema declares, whose values have the type the
 * schema asks for (a string that is the exact literal of an integer, number,
 * boolean, array or object parameter is made into it, and the call says so in
 * `repairs`; see coerceString), and which carries every required key.
 * Anything else stays text.
 */
import type { DialectTool, RecoveredCall, RecoveryEvent } from "./qwenXml.js";
import { fittedCall } from "./schemaCheck.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One call object, or undefined when it is not a complete valid call. */
function callFromObject(
  value: unknown,
  tools: DialectTool[],
  raw: string,
): RecoveredCall | undefined {
  if (!isObject(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "name" && key !== "parameters") {
      return undefined;
    }
  }
  if ("type" in value && value.type !== "function") return undefined;
  const { name, parameters } = value;
  if (typeof name !== "string" || !isObject(parameters)) return undefined;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return undefined;
  return fittedCall(tool, parameters, raw);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The calls in `text` when all of it is Llama JSON calls, else undefined. */
export function recoverLlamaJsonCalls(
  text: string,
  tools: DialectTool[],
): RecoveredCall[] | undefined {
  const body = text.trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return undefined;
  const parsed = parseJson(body);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return undefined;
  const calls: RecoveredCall[] = [];
  for (const item of items) {
    // An array element may be the call as a JSON-encoded string.
    const inner =
      Array.isArray(parsed) && typeof item === "string"
        ? parseJson(item)
        : item;
    const call = callFromObject(
      inner,
      tools,
      typeof item === "string" ? item : JSON.stringify(item),
    );
    if (!call) return undefined;
    calls.push(call);
  }
  return calls;
}

/** A call in the form Llama writes it, for round-trip tests. */
export function renderLlamaJsonCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: "function",
    name: call.name,
    parameters: call.arguments,
  });
}

/**
 * Stream-safe recovery for one text block. The reply is a call only if the
 * block's first non-blank character is `{` or `[`, so a block that starts any
 * other way is released at once and never held. A block that does start so is
 * held whole and parsed at `end`: calls (not shown), or released unchanged.
 */
export class LlamaJsonRecovery {
  private pending = ""; // leading whitespace, not yet judged
  private held: string | undefined;
  private passthrough = false;

  constructor(private readonly tools: DialectTool[]) {}

  push(chunk: string): RecoveryEvent[] {
    if (this.held !== undefined) {
      this.held += chunk;
      return [];
    }
    if (this.passthrough) {
      return chunk ? [{ type: "text", text: chunk }] : [];
    }
    const buffer = this.pending + chunk;
    this.pending = "";
    const first = buffer.search(/\S/);
    if (first === -1) {
      this.pending = buffer;
      return [];
    }
    if (buffer[first] === "{" || buffer[first] === "[") {
      this.held = buffer;
      return [];
    }
    this.passthrough = true;
    return [{ type: "text", text: buffer }];
  }

  end(): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.held !== undefined) {
      const calls = recoverLlamaJsonCalls(this.held, this.tools);
      if (calls) {
        for (const call of calls) out.push({ type: "call", call });
      } else {
        out.push({ type: "text", text: this.held });
      }
    } else if (this.pending) {
      out.push({ type: "text", text: this.pending });
    }
    this.pending = "";
    this.held = undefined;
    this.passthrough = false;
    return out;
  }
}

/** One-shot form for a complete reply. */
export function recoverLlamaJsonFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  const parser = new LlamaJsonRecovery(tools);
  const events = [...parser.push(text), ...parser.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}
