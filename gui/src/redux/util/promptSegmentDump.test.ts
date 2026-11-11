import { afterEach, describe, expect, it, vi } from "vitest";
import { dumpPromptSegments } from "./promptSegmentDump";
import { IDE_SCENARIOS } from "./segmentScenarios";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("CONTINUE_PROMPT_SEGMENTS in the IDE", () => {
  it("prints nothing unless the key is set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    dumpPromptSegments(IDE_SCENARIOS["ide-agent-claude"]());
    expect(info).not.toHaveBeenCalled();
  });

  it("prints one line per segment, never contents", () => {
    localStorage.setItem("CONTINUE_PROMPT_SEGMENTS", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    dumpPromptSegments(IDE_SCENARIOS["ide-agent-claude"]());
    const out = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("[prompt-segments] req=1 model=claude-sonnet-4-6");
    expect(out).toMatch(/turn\.agent@full region=system stability=static/);
    expect(out).toContain("first_changed_vs_prev=first");
    expect(out).not.toContain("Fix the bug in lexer.ts");
    expect(out).not.toContain("British English");
  });
});
