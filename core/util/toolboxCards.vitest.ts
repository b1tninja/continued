import { describe, expect, it } from "vitest";
import {
  fillToolboxCard,
  TOOLBOX_CARDS,
  TOOLBOX_GROUPS,
  toolboxCardsIn,
} from "./toolboxCards";

describe("the card list", () => {
  it("has unique ids and a group for each card that exists", () => {
    const ids = TOOLBOX_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(TOOLBOX_GROUPS.map((g) => g.id));
    for (const card of TOOLBOX_CARDS) expect(groups.has(card.group)).toBe(true);
  });

  it("lists every group with at least one card, in order", () => {
    for (const group of TOOLBOX_GROUPS) {
      expect(toolboxCardsIn(group.id).length).toBeGreaterThan(0);
    }
    expect(toolboxCardsIn("diagnose").map((c) => c.id)[0]).toBe(
      "reproduce-first",
    );
  });

  it("keeps every prompt under 80 words, and names the method only on the card", () => {
    for (const card of TOOLBOX_CARDS) {
      expect(card.prompt.split(/\s+/).length).toBeLessThan(80);
      expect(card.prompt).not.toMatch(/5 Whys|Fishbone|SWOT|PDCA|Six Thinking/);
    }
  });

  it("shows the method names the research and MIT list give, and no others", () => {
    const methods = new Set(TOOLBOX_CARDS.map((c) => c.method).filter(Boolean));
    expect([...methods].sort()).toEqual(
      [
        "5 Whys",
        "Brainstorming",
        "Design thinking",
        "Fishbone",
        "PDCA",
        "Root cause analysis",
        "SWOT",
        "Six Thinking Hats (critical and risk)",
        "Systems thinking",
      ].sort(),
    );
  });
});

describe("fillToolboxCard", () => {
  const card = {
    prompt:
      "Write the smallest test that fails. Then fix it. Run the check {lastCheck}",
  };

  it("keeps a sentence and fills its placeholder when the fact is there", () => {
    expect(fillToolboxCard(card, { lastCheck: "npm test: exit 1" })).toBe(
      "Write the smallest test that fails. Then fix it. Run the check npm test: exit 1",
    );
  });

  it("drops a sentence whose fact is missing, keeping the others", () => {
    const text = fillToolboxCard({
      prompt: "First sentence. Second one {changedFiles}. Last sentence.",
    });
    expect(text).toBe("First sentence. Last sentence.");
    expect(text).not.toContain("{");
  });

  it("treats a blank fact as missing", () => {
    const text = fillToolboxCard(
      { prompt: "Keep this. Drop this {request}" },
      { request: "   " },
    );
    expect(text).toBe("Keep this.");
  });

  it("returns a prompt with no placeholders unchanged", () => {
    const plain = "Say what you ran. Separate what you verified.";
    expect(fillToolboxCard({ prompt: plain })).toBe(plain);
  });

  it("leaves no placeholder in any card when every fact is given", () => {
    const facts = {
      request: "Fix the login bug",
      item: "Write the lexer",
      lastCheck: "npm test: exit 1",
      lastError: "TypeError: x is undefined",
      changedFiles: "src/a.ts",
      assumptions: "the cache is warm",
    };
    for (const card of TOOLBOX_CARDS) {
      expect(fillToolboxCard(card, facts)).not.toMatch(/\{\w+\}/);
    }
  });

  it("with no facts, only the cards that need none keep all their text", () => {
    const why = TOOLBOX_CARDS.find((c) => c.id === "why-chain")!;
    expect(fillToolboxCard(why)).toBe(
      "Start from this failure and ask why it happened. Answer with evidence from the code or the output, not a guess, then ask why again. Stop at the first cause you can test with one command, and run that command. Five steps at most.",
    );
  });
});
