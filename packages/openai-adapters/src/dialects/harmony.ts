/**
 * The `harmony` dialect: gpt-oss writes in OpenAI's Harmony format, and a
 * function call is a message addressed to `functions.NAME` on the commentary
 * channel, ended by the stop token `<|call|>`:
 *
 *   <|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"Paris"}<|call|>
 *
 * Sources, read 2026-11-10:
 * - https://github.com/openai/harmony/blob/main/docs/format.md, "Receiving
 *   tool calls": "it will define a `recipient` in the header of the message
 *   using the format `to={name}` ... `commentary` as the channel ... The
 *   recipient might be defined in the role or channel section of the header.
 *   The model might also specify a `<|constrain|>` token to indicate the type
 *   of input for the tool call." Example there:
 *   `<|channel|>analysis<|message|>Need to use function get_weather.<|end|>`
 *   `<|start|>assistant<|channel|>commentary to=functions.get_weather
 *   <|constrain|>json<|message|>{"location":"San Francisco"}<|call|>`.
 *   Also "Preambles": a commentary message with no recipient, shown to the user.
 * - https://huggingface.co/openai/gpt-oss-120b/blob/main/chat_template.jinja,
 *   which renders a call as `<|start|>assistant to=functions.NAME<|channel|>
 *   commentary json<|message|>ARGS<|call|>` (recipient in the role section).
 *
 * gpt-oss and Bedrock Converse return structured calls; this parser matters
 * for a self-hosted server that returns the raw tokens in the content. Opt-in.
 *
 * Strict, like the other dialects. The whole reply must be Harmony messages,
 * each `[<|start|>assistant]` HEADER `<|message|>` BODY TERMINATOR, where
 *
 * - a call: channel `commentary`, recipient `functions.NAME` (in the role or
 *   the channel part of the header), an optional `<|constrain|>json` (or a bare
 *   `json`), a body that is one JSON object, terminator `<|call|>`;
 * - an analysis message (channel `analysis`, no recipient, `<|end|>`) is the
 *   model's reasoning and is dropped;
 * - a preamble (channel `commentary`, no recipient, `<|end|>`) before the
 *   first call is kept as text.
 *
 * Messages after the first begin with `<|start|>assistant`. Nothing else is
 * accepted: a `final` message, another recipient (`browser.search`, `python`),
 * another constrain type, a body that is not JSON, an undeclared tool or
 * argument, a missing `<|call|>`, text between messages. The reply is then text.
 */
import { fittedCall } from "./schemaCheck.js";
import {
  HeldBlockRecovery,
  type ParsedReply,
  recoverWhole,
  skipSpace,
} from "./heldRecovery.js";
import type { DialectTool, RecoveredCall } from "./qwenXml.js";

const START = "<|start|>assistant";
const CHANNEL = "<|channel|>";
const MESSAGE = "<|message|>";
const TERMINATORS = ["<|call|>", "<|end|>", "<|return|>"];
const OTHER_TOKENS = ["<|start|>", CHANNEL, MESSAGE, "<|constrain|>"];

const HEADER =
  /^(?: to=([^\s<]+))?<\|channel\|>([a-z]+)(?: to=([^\s<]+))?(?:\s*<\|constrain\|>\s*([a-z]+)|\s+(json))?$/;

interface Header {
  channel: string;
  recipient: string | undefined;
  constrain: string | undefined;
}

function parseHeader(text: string): Header | undefined {
  const m = HEADER.exec(text);
  if (!m || (m[1] && m[3])) return undefined;
  return {
    channel: m[2],
    recipient: m[1] ?? m[3],
    constrain: m[4] ?? m[5],
  };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The first terminator at or after `from`: where it is and which one. */
function nextTerminator(
  text: string,
  from: number,
): { at: number; token: string } | undefined {
  let best: { at: number; token: string } | undefined;
  for (const token of TERMINATORS) {
    const at = text.indexOf(token, from);
    if (at !== -1 && (!best || at < best.at)) best = { at, token };
  }
  return best;
}

/** The calls in `text` when all of it is Harmony calls, else undefined. */
export function recoverHarmonyCalls(
  text: string,
  tools: DialectTool[],
): ParsedReply | undefined {
  const preambles: string[] = [];
  const calls: RecoveredCall[] = [];
  let pos = skipSpace(text, 0);
  for (let first = true; pos < text.length; first = false) {
    const begin = pos;
    if (text.startsWith(START, pos)) pos += START.length;
    else if (!first) return undefined;
    const open = text.indexOf(MESSAGE, pos);
    if (open === -1) return undefined;
    const header = parseHeader(text.slice(pos, open));
    const bodyStart = open + MESSAGE.length;
    const stop = nextTerminator(text, bodyStart);
    if (!header || !stop) return undefined;
    const body = text.slice(bodyStart, stop.at);
    if (OTHER_TOKENS.some((t) => body.includes(t))) return undefined;
    const raw = text.slice(begin, stop.at + stop.token.length);
    if (header.recipient === undefined) {
      if (stop.token !== "<|end|>" || calls.length > 0) return undefined;
      if (header.channel === "commentary" && header.constrain === undefined) {
        preambles.push(body);
      } else if (header.channel !== "analysis") {
        return undefined;
      }
    } else {
      const call = callFrom(header, stop.token, body, tools, raw);
      if (!call) return undefined;
      calls.push(call);
    }
    pos = skipSpace(text, stop.at + stop.token.length);
  }
  return calls.length > 0 ? { lead: preambles.join("\n\n"), calls } : undefined;
}

function callFrom(
  header: Header,
  terminator: string,
  body: string,
  tools: DialectTool[],
  raw: string,
): RecoveredCall | undefined {
  if (terminator !== "<|call|>" || header.channel !== "commentary") {
    return undefined;
  }
  if (header.constrain !== undefined && header.constrain !== "json") {
    return undefined;
  }
  const recipient = header.recipient ?? "";
  if (!recipient.startsWith("functions.")) return undefined;
  const tool = tools.find((t) => t.name === recipient.slice(10));
  const args = parseObject(body);
  return tool && args ? fittedCall(tool, args, raw) : undefined;
}

/** A call as the gpt-oss template writes it, for round-trip tests. */
export function renderHarmonyCall(call: {
  name: string;
  arguments: Record<string, unknown>;
}): string {
  return `<|channel|>commentary to=functions.${call.name} <|constrain|>json<|message|>${JSON.stringify(call.arguments)}<|call|>`;
}

/** Stream-safe recovery for one text block (see HeldBlockRecovery). */
export class HarmonyRecovery extends HeldBlockRecovery {
  constructor(tools: DialectTool[]) {
    super(tools, [CHANNEL, "<|start|>"], recoverHarmonyCalls);
  }
}

/** One-shot form for a complete reply. */
export function recoverHarmonyFromText(
  text: string,
  tools: DialectTool[],
): { text: string; calls: RecoveredCall[] } {
  return recoverWhole(new HarmonyRecovery(tools), text);
}
