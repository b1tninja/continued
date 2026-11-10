import { describe, expect, it } from "vitest";
import { ContinueErrorReason } from "../../util/errors";
import { editFailureCorpus } from "./editFailureCorpus";
import { executeFindAndReplace } from "./performReplace";
import { recoverMatch } from "./recoverMatch";

function applyRecovered(file: string, old: string, neu: string) {
  const r = recoverMatch(file, old, neu);
  if (!r.ok) return r;
  return {
    ...r,
    result:
      file.slice(0, r.match.startIndex) +
      r.match.newString +
      file.slice(r.match.endIndex),
  };
}

describe("recoverMatch corpus (synthesised failures)", () => {
  it.each(editFailureCorpus.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = applyRecovered(c.file, c.oldString, c.newString);
    if (c.expect.kind === "applies") {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.match.strategy).toBe(c.expect.strategy);
        expect((r as { result: string }).result).toBe(c.expect.result);
      }
    } else {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(c.expect.reason);
        for (const s of c.expect.includes) expect(r.message).toContain(s);
      }
    }
  });
});

describe("recoverMatch safety", () => {
  it("never applies when two places match", () => {
    const file = "  x();\n  y();\nother\n    x();\n    y();\n";
    const r = recoverMatch(file, "x();\ny();", "z();");
    expect(r.ok).toBe(false);
  });

  it("keeps a trailing newline decision from old_string", () => {
    const file = "if (a) {\n    go();\n}\n";
    const r = applyRecovered(file, "      go();\n", "      stop();\n");
    expect(r.ok).toBe(true);
    expect((r as { result: string }).result).toBe("if (a) {\n    stop();\n}\n");
  });

  it("does not apply a fuzzy match below the bar", () => {
    const file = "const aaaaaaaaaa = bbbbbbbbbb(cccccccc);\n";
    const r = recoverMatch(
      file,
      "const zzzzzzzzzz = yyyyyyyyyy(xxxxxxxx);",
      "q",
    );
    expect(r.ok).toBe(false);
  });
});

describe("executeFindAndReplace wiring", () => {
  it("exact matches are unchanged", () => {
    expect(executeFindAndReplace("a b c", "b", "X", false)).toBe("a X c");
  });

  it("applies a unique recovered match", () => {
    const file =
      "const message = computeGreeting(user.firstName, user.lastName);\nlog(message);\n";
    const out = executeFindAndReplace(
      file,
      "const mesage = computeGreeting(user.firstName, user.lastName);\nlog(message);",
      "ok();",
      false,
    );
    expect(out).toBe("ok();\n");
  });

  it("does not recover under replace_all", () => {
    const file =
      "const message = computeGreeting(user.firstName, user.lastName);\nlog(message);\n";
    expect(() =>
      executeFindAndReplace(
        file,
        "const mesage = computeGreeting(user.firstName, user.lastName);\nlog(message);",
        "ok();",
        true,
      ),
    ).toThrowError(
      expect.objectContaining({
        reason: ContinueErrorReason.FindAndReplaceOldStringNotFound,
      }),
    );
  });

  it("says which line diverged", () => {
    const file = "alpha();\nbeta();\ngamma();\n";
    let msg = "";
    try {
      executeFindAndReplace(file, "alpha();\nbeta(1);\nzzz();", "x", false, 3);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Edit at index 3: string not found in file");
    expect(msg).toContain("Line 2 of old_string is the first that differs");
    expect(msg).toContain('file line 2: "beta();"');
  });
});
