/**
 * Text-stream filters for model-specific markup that leaks into text.
 *
 * These are the first pieces of the ToolDialect layer (plans/tool-dialects.md):
 * each one is stream-safe, holding back a trailing fragment that could still
 * become a marker until the next delta settles it. They lived twice, in
 * core/llm/llms/bedrockHelpers.ts and apis/bedrockHelpers.ts; this is the one
 * copy, and both re-export it.
 */

/**
 * DeepSeek V3.2 on Bedrock ends the text block before each `toolUse` block
 * with this fragment of its own tool-call markup (fullwidth bars).
 */
export const DEEPSEEK_DSML_MARKER = "<\uFF5CDSML\uFF5Cfunction_calls";

export function leaksDsmlMarker(modelId: string): boolean {
  return /(^|\.)deepseek\.v3/i.test(modelId);
}

/**
 * Splits text buffered from one content block into what can be shown now and
 * what has to wait: a trailing piece that could still become the marker, or
 * the marker and everything after it, which `flushDsmlHold` drops at the end
 * of the block.
 */
export function holdBackDsmlMarker(buffered: string): {
  emit: string;
  hold: string;
} {
  const at = buffered.indexOf(DEEPSEEK_DSML_MARKER);
  if (at !== -1) {
    return { emit: buffered.slice(0, at), hold: buffered.slice(at) };
  }
  const max = Math.min(buffered.length, DEEPSEEK_DSML_MARKER.length - 1);
  for (let n = max; n > 0; n--) {
    if (DEEPSEEK_DSML_MARKER.startsWith(buffered.slice(-n))) {
      return { emit: buffered.slice(0, -n), hold: buffered.slice(-n) };
    }
  }
  return { emit: buffered, hold: "" };
}

/** What held-back text to show when its block ends: nothing if it was the marker. */
export function flushDsmlHold(hold: string): string {
  return hold.startsWith(DEEPSEEK_DSML_MARKER) ? "" : hold;
}

/**
 * Nova Pro, Lite, Micro and Premier write their reasoning into the text as
 * literal `<thinking>...</thinking>` (Nova Pro, seen live 2026-11-08), so the
 * GUI showed the reasoning as the answer. Nova 2 uses reasoningContent and
 * does not match.
 */
export function writesThinkingTags(modelId: string): boolean {
  return /nova-(pro|lite|micro|premier)/i.test(modelId);
}

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

/** Text split into what is shown as the answer and what is shown as reasoning. */
export interface ThinkingSplit {
  content: string;
  reasoning: string;
}

/** The longest proper prefix of `tag` that `text` ends with, as a length. */
function trailingTagPrefix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

/**
 * Lifts `<thinking>...</thinking>` out of a text stream into reasoning, one
 * block at a time: `push` takes each text delta and returns what can be shown
 * now, holding back a trailing fragment that could still become a tag;
 * `flush` releases what is held when the block ends. Text outside the tags
 * stays content; the newlines right after a closing tag are dropped so the
 * answer does not start with a blank line.
 */
export class ThinkingTagSplitter {
  private hold = "";
  private inside = false;
  private skipNewlines = false;

  push(text: string): ThinkingSplit {
    let buffered = this.hold + text;
    this.hold = "";
    const out: ThinkingSplit = { content: "", reasoning: "" };
    for (;;) {
      if (this.skipNewlines) {
        buffered = buffered.replace(/^[\r\n]+/, "");
        if (buffered) this.skipNewlines = false;
      }
      const tag = this.inside ? THINKING_CLOSE : THINKING_OPEN;
      const at = buffered.indexOf(tag);
      if (at !== -1) {
        this.emit(out, buffered.slice(0, at));
        buffered = buffered.slice(at + tag.length);
        this.inside = !this.inside;
        if (!this.inside) this.skipNewlines = true;
        continue;
      }
      const partial = trailingTagPrefix(buffered, tag);
      this.hold = partial ? buffered.slice(-partial) : "";
      this.emit(out, partial ? buffered.slice(0, -partial) : buffered);
      return out;
    }
  }

  /** What is still held when the block ends: a fragment that never became a tag. */
  flush(): ThinkingSplit {
    const out: ThinkingSplit = { content: "", reasoning: "" };
    this.emit(out, this.hold);
    this.hold = "";
    return out;
  }

  private emit(out: ThinkingSplit, text: string): void {
    if (!text) return;
    if (this.inside) out.reasoning += text;
    else out.content += text;
  }
}
