import type { DialectTool, RecoveredCall, RecoveryEvent } from "./qwenXml.js";

/** What a whole-reply parser returns: text kept before the calls, and the calls. */
export interface ParsedReply {
  lead: string;
  calls: RecoveredCall[];
}

/**
 * The most text a stage holds for one reply, in characters (about 1 MiB). A
 * real call is a few KB; past this the text is released as text and nothing
 * more is held until the reply ends, so a model that opens a marker and never
 * closes it cannot grow the buffer without bound or stall the person.
 */
export const MAX_HELD_CHARS = 1 << 20;

export const THINK_OPEN = "<think>";
export const THINK_CLOSE = "</think>";

/** The leading `<think>` block of `s` with the whitespace after it, or "". */
export function leadingThink(s: string): string {
  const lead = s.length - s.trimStart().length;
  if (!s.startsWith(THINK_OPEN, lead)) return "";
  const end = s.indexOf(THINK_CLOSE, lead);
  if (end === -1) return "";
  const after = end + THINK_CLOSE.length;
  const rest = s.slice(after);
  return (
    s.slice(0, after) + rest.slice(0, rest.length - rest.trimStart().length)
  );
}

/**
 * Whether `shown`, the text of a block released before a call marker, is
 * more than whitespace and a leading `<think>` block. The whole reply must be
 * calls (plans/ROADMAP.md Q28), so a call after prose is not recovered.
 */
export function hasProseBefore(shown: string): boolean {
  return shown.slice(leadingThink(shown).length).trim() !== "";
}

export function skipSpace(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/**
 * Stream-safe recovery for one text block of a dialect whose calls are
 * wrapped in markers. A block is held only while its first non-blank text can
 * still be (or is) one of `starts`; any other start is released at once. A
 * held block is judged at `end` by `parse`: the lead text and the calls, or
 * the block unchanged.
 */
export class HeldBlockRecovery {
  private buffer = "";
  private state: "undecided" | "held" | "passthrough" = "undecided";
  private capped = false;

  constructor(
    private readonly tools: DialectTool[],
    private readonly starts: string[],
    private readonly parse: (
      text: string,
      tools: DialectTool[],
    ) => ParsedReply | undefined,
  ) {}

  push(chunk: string): RecoveryEvent[] {
    this.buffer += chunk;
    if (this.state === "undecided") {
      const s = this.buffer.trimStart();
      if (s === "") return [];
      if (this.starts.some((m) => s.startsWith(m))) this.state = "held";
      else if (this.starts.some((m) => m.startsWith(s))) return [];
      else this.state = "passthrough";
    }
    if (this.state === "passthrough") {
      const out = this.buffer;
      this.buffer = "";
      return out ? [{ type: "text", text: out }] : [];
    }
    if (this.buffer.length > MAX_HELD_CHARS) {
      const out = this.buffer;
      this.buffer = "";
      this.state = "passthrough";
      this.capped = true;
      return [{ type: "text", text: out }];
    }
    return [];
  }

  isHolding(): boolean {
    return this.state === "held" && this.buffer !== "";
  }

  /** Whether the cap released held text since this was last called. */
  takeCapReleased(): boolean {
    const was = this.capped;
    this.capped = false;
    return was;
  }

  end(): RecoveryEvent[] {
    const out: RecoveryEvent[] = [];
    if (this.buffer) {
      const found =
        this.state === "held" ? this.parse(this.buffer, this.tools) : undefined;
      if (found) {
        if (found.lead) out.push({ type: "text", text: found.lead });
        for (const call of found.calls) out.push({ type: "call", call });
      } else {
        out.push({ type: "text", text: this.buffer });
      }
    }
    this.buffer = "";
    this.state = "undecided";
    return out;
  }
}

/** One-shot form for a complete reply. */
export function recoverWhole(
  recovery: HeldBlockRecovery,
  text: string,
): { text: string; calls: RecoveredCall[] } {
  const events = [...recovery.push(text), ...recovery.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}
