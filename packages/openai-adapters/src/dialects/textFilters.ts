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
 * What every DSML tag starts with, fullwidth bars (U+FF5C) as the tokenizer
 * writes them and the ASCII look-alike. The fragment seen live ends right
 * after `function_calls` with no `>`, so the hold-back keys on the start of the
 * markup, not on one whole tag name.
 */
const DSML_STARTS = [DEEPSEEK_DSML_MARKER.slice(0, 7), "<|DSML|"];

function dsmlStart(text: string): number {
  let at = -1;
  for (const start of DSML_STARTS) {
    const i = text.indexOf(start);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  return at;
}

/**
 * Splits text buffered from one content block into what can be shown now and
 * what has to wait: the marker may arrive split across deltas, so a trailing
 * piece that could still become it is held back, and once the marker is seen
 * it and everything after it are held for `flushDsmlHold` to drop at the end
 * of the block.
 */
export function holdBackDsmlMarker(buffered: string): {
  emit: string;
  hold: string;
} {
  const at = dsmlStart(buffered);
  if (at !== -1) {
    return { emit: buffered.slice(0, at), hold: buffered.slice(at) };
  }
  let keep = 0;
  for (const start of DSML_STARTS) {
    keep = Math.max(keep, trailingTagPrefix(buffered, start));
  }
  if (keep > 0) {
    return { emit: buffered.slice(0, -keep), hold: buffered.slice(-keep) };
  }
  return { emit: buffered, hold: "" };
}

/** What held-back text to show when its block ends: nothing if it was the marker. */
export function flushDsmlHold(hold: string): string {
  return dsmlStart(hold) === 0 ? "" : hold;
}

/** A complete text block with the marker and what follows it removed. */
export function stripDsmlMarker(text: string): string {
  const at = dsmlStart(text);
  return at === -1 ? text : text.slice(0, at);
}

/** The literal tags a model writes its reasoning between, when it does. */
export interface ThinkingTags {
  open: string;
  close: string;
}

/**
 * Nova Pro, Lite, Micro and Premier write their reasoning into the text as
 * literal `<thinking>...</thinking>` (Nova Pro, seen live 2026-11-08), so the
 * GUI showed the reasoning as the answer. Nova 2 uses reasoningContent and
 * does not match. Kimi K2 Thinking leaked a literal `<think>...</think>` into
 * the text of a reply to a tool result (seen live 2026-11-10).
 */
export function thinkingTagsFor(modelId: string): ThinkingTags | undefined {
  if (/nova-(pro|lite|micro|premier)/i.test(modelId)) {
    return { open: "<thinking>", close: "</thinking>" };
  }
  if (/kimi-k2-thinking/i.test(modelId)) {
    return { open: "<think>", close: "</think>" };
  }
  return undefined;
}

export function writesThinkingTags(modelId: string): boolean {
  return thinkingTagsFor(modelId) !== undefined;
}

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

  constructor(
    private readonly tags: ThinkingTags = {
      open: "<thinking>",
      close: "</thinking>",
    },
  ) {}

  push(text: string): ThinkingSplit {
    let buffered = this.hold + text;
    this.hold = "";
    const out: ThinkingSplit = { content: "", reasoning: "" };
    for (;;) {
      if (this.skipNewlines) {
        buffered = buffered.replace(/^[\r\n]+/, "");
        if (buffered) this.skipNewlines = false;
      }
      const tag = this.inside ? this.tags.close : this.tags.open;
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

/** The splitter for this model's reasoning tags, or undefined if it writes none. */
export function createThinkingTagSplitter(
  modelId: string,
): ThinkingTagSplitter | undefined {
  const tags = thinkingTagsFor(modelId);
  return tags ? new ThinkingTagSplitter(tags) : undefined;
}

/**
 * A complete text block (the non-streaming path) with what the stream filters
 * remove removed: the DeepSeek DSML fragment, and reasoning tags lifted out of
 * the answer into `reasoning`.
 */
export function cleanReplyText(modelId: string, text: string): ThinkingSplit {
  const body = leaksDsmlMarker(modelId) ? stripDsmlMarker(text) : text;
  const splitter = createThinkingTagSplitter(modelId);
  if (!splitter) return { content: body, reasoning: "" };
  const first = splitter.push(body);
  const rest = splitter.flush();
  return {
    content: first.content + rest.content,
    reasoning: first.reasoning + rest.reasoning,
  };
}
