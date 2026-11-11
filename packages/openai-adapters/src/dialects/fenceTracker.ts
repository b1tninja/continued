/**
 * Whether the text seen so far is inside a markdown code fence, kept as a
 * running count so that each question costs O(1). A stage that asks "is this
 * marker quoted?" once per marker would otherwise rescan the whole reply each
 * time, which is quadratic when a long reply quotes a marker thousands of
 * times. Backticks count in whole runs of three (a run of four is one fence
 * and a stray tick), the same as splitting the text on "```".
 */
export class FenceTracker {
  private fenceRuns = 0;
  private tickRun = 0;
  private last = "";

  /** Take the next piece of text, in order. Cost is linear in `text`. */
  add(text: string): void {
    if (!text) return;
    this.last = text[text.length - 1];
    for (const m of text.matchAll(/`+|[^`]+/g)) {
      if (m[0][0] === "`") {
        this.tickRun += m[0].length;
      } else {
        this.fenceRuns += Math.floor(this.tickRun / 3);
        this.tickRun = 0;
      }
    }
  }

  /** Whether the text so far ends inside an open fence. */
  get inFence(): boolean {
    return (this.fenceRuns + Math.floor(this.tickRun / 3)) % 2 === 1;
  }

  /** Whether the last character taken was a backtick. */
  get endsWithTick(): boolean {
    return this.last === "`";
  }
}
