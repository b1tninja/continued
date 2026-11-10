import { describe, expect, it } from "vitest";
import { STUCK_NOTE_MARK, stripStuckNote, stuckNote } from "./stuckNotes";
import { detectStuck, type StuckCall, type StuckStep } from "./stuckSignals";

const call = (
  tool: string,
  args: Record<string, unknown>,
  more: Partial<StuckCall> = {},
): StuckCall => ({ tool, args, ...more });
const bash = (command: string, result: string, error = true) =>
  call("Bash", { command }, { result, error });
const step = (...calls: StuckCall[]): StuckStep => ({ calls });

const noteOf = (steps: StuckStep[]) => stuckNote(detectStuck(steps));

describe("stuckNote (L1)", () => {
  it("says nothing for a healthy history: a test re-run after each edit", () => {
    const fail = "FAIL: 1 test failed";
    const edit = (n: number) =>
      call(
        "Edit",
        { path: "a.ts" },
        { result: "ok", changed: [{ path: "a.ts", hash: `h${n}` }] },
      );
    expect(
      noteOf([
        step(bash("npm test", fail)),
        step(edit(1)),
        step(bash("npm test", fail)),
        step(edit(2)),
        step(bash("npm test", fail)),
      ]),
    ).toBeUndefined();
  });

  it("notes the same error from different calls", () => {
    const note = noteOf([
      step(bash("npm test --silent", "Error: Cannot find module 'x'")),
      step(bash("npm test --verbose", "Error: Cannot find module 'x'")),
    ]);
    expect(note).toBeDefined();
    expect(note!.startsWith(STUCK_NOTE_MARK)).toBe(true);
    expect(note).toContain("same error");
  });

  it("notes an edit that is reverted", () => {
    const e = (hash: string) =>
      step(
        call(
          "Edit",
          { path: "a.ts" },
          { result: "ok", changed: [{ path: "a.ts", hash }] },
        ),
      );
    expect(noteOf([e("a"), e("b"), e("a")])).toContain("back to content");
  });

  it("leaves repeat-call to the repeat guard", () => {
    const r = step(
      call("Read", { path: "a.ts" }, { result: "x", read: ["a.ts"] }),
    );
    const report = detectStuck([r, r, r]);
    expect(report.signals.map((s) => s.kind)).toContain("repeat-call");
    expect(stuckNote(report)).toBeUndefined();
  });

  it("strips a note back out", () => {
    expect(stripStuckNote(`out${STUCK_NOTE_MARK}text`)).toBe("out");
    expect(stripStuckNote("out")).toBe("out");
  });
});
