import { describe, expect, test } from "vitest";

import type { LoopPolicy, LoopState, TaskPlan } from "../index.js";

import {
  autonomyForPolicy,
  createLoop,
  holdQuestion,
  loopAutonomy,
  loopDecidesAlone,
  loopQuestionDecider,
  replanDecision,
  repairDecision,
  replanDiff,
  setLoopPolicy,
  startItemRun,
} from "./loopMode.js";

const T0 = new Date("2026-11-08T10:00:00Z");

const plan = (...texts: string[]): TaskPlan => ({
  items: texts.map((text, i) => ({
    id: String(i + 1),
    text,
    status: "pending" as const,
  })),
  updatedAt: T0.toISOString(),
});

const loopWith = (policy: Partial<LoopPolicy>): LoopState =>
  startItemRun(
    createLoop(plan("A", "B"), {
      now: T0,
      sessionTokens: 0,
      policy: { plan: "cautious", questions: "cautious", ...policy },
    }),
    "1",
    0,
    T0,
  );

describe("a loop that follows policy levels", () => {
  test("its limits and strategy come from the levels", () => {
    expect(autonomyForPolicy({ plan: "manual", questions: "manual" })).toBe(
      "supervised",
    );
    expect(autonomyForPolicy({ plan: "cautious", questions: "cautious" })).toBe(
      "auto",
    );
    expect(
      autonomyForPolicy({ plan: "permissive", questions: "cautious" }),
    ).toBe("unattended");
    expect(autonomyForPolicy({ plan: "manual", questions: "yolo" })).toBe(
      "idgaf",
    );
    expect(loopWith({ plan: "permissive" }).autonomy).toBe("unattended");
  });

  test("a question waits until it is answered: no timer unless nobody can answer", () => {
    expect(loopAutonomy(loopWith({ plan: "permissive" })).waitTimeoutMs).toBe(
      0,
    );
    expect(loopAutonomy(loopWith({ questions: "yolo" })).waitTimeoutMs).toBe(
      1000,
    );
  });

  test("changing the policy keeps the limits and the strategy", () => {
    const loop = loopWith({});
    const changed = setLoopPolicy(loop, {
      plan: "permissive",
      questions: "cautious",
    });
    expect(changed.policy?.plan).toBe("permissive");
    expect(changed.budget).toEqual(loop.budget);
    expect(changed.strategy).toBe(loop.strategy);
  });
});

describe("Plan edits decides a re-plan", () => {
  const before = ["A", "B"];

  test("Manual: every re-plan waits", () => {
    const d = replanDecision(
      loopWith({ plan: "manual" }),
      before,
      plan("A", "B"),
    );
    expect(d.accept).toBe(false);
  });

  test("Cautious: a re-plan that adds nothing goes on, one that adds waits", () => {
    const loop = loopWith({ plan: "cautious" });
    expect(replanDecision(loop, before, plan("A", "B")).accept).toBe(true);
    expect(replanDecision(loop, before, plan("A", "B", "C")).accept).toBe(
      false,
    );
  });

  test("Permissive: a re-plan may add up to the limit", () => {
    const loop = loopWith({ plan: "permissive", maxNewPlanItems: 2 });
    expect(replanDecision(loop, before, plan("A", "B", "C", "D")).accept).toBe(
      true,
    );
    expect(
      replanDecision(loop, before, plan("A", "B", "C", "D", "E")).accept,
    ).toBe(false);
  });

  test("IDGAF: every re-plan goes on", () => {
    const loop = loopWith({ plan: "yolo" });
    expect(
      replanDecision(loop, before, plan("A", "B", "1", "2", "3", "4", "5", "6"))
        .accept,
    ).toBe(true);
  });

  test("Automatic waits: no reviewer for plans exists yet", () => {
    expect(
      replanDecision(loopWith({ plan: "automatic" }), before, plan("A", "B"))
        .accept,
    ).toBe(false);
  });

  test("a repair of just the failed item goes on at every level but Manual", () => {
    const repaired = plan("A", "B, first half", "B, second half");
    for (const level of ["cautious", "permissive", "yolo"] as const) {
      expect(
        repairDecision(loopWith({ plan: level }), before, "B", repaired).accept,
      ).toBe(true);
    }
    expect(
      repairDecision(loopWith({ plan: "manual" }), before, "B", repaired)
        .accept,
    ).toBe(false);
  });
});

describe("Questions decides who answers", () => {
  const hold = (loop: LoopState, type: string) =>
    holdQuestion(
      loop,
      {
        itemId: "1",
        question: "Which?",
        kind: "assumption",
        assumption: "the first",
        type,
      },
      T0,
    );

  test("IDGAF: the agent decides every question, whatever its type", () => {
    const loop = loopWith({ questions: "yolo" });
    expect(loopDecidesAlone(loop)).toBe(true);
    const held = hold(loop, "security");
    expect(held.ok && held.question.decidedAlone).toBe(true);
  });

  test("Cautious: you decide, except types the agent may decide", () => {
    const loop = loopWith({ questions: "cautious" });
    expect(loopQuestionDecider(loop, "scope")).toBe("person");
    expect(loopQuestionDecider(loop, "detail")).toBe("agent");
    expect(loopQuestionDecider(loop, undefined)).toBe("person");
    const held = hold(loop, "detail");
    expect(held.ok && held.question.decidedAlone).toBe(true);
    const asked = hold(loop, "scope");
    expect(asked.ok && asked.question.decidedAlone).toBeUndefined();
  });

  test("Permissive: the agent decides, except types you keep", () => {
    const loop = loopWith({ questions: "permissive" });
    expect(loopQuestionDecider(loop, "design")).toBe("agent");
    expect(loopQuestionDecider(loop, "security")).toBe("person");
    expect(
      loopQuestionDecider(
        loopWith({ questions: "permissive", youDecide: ["design"] }),
        "design",
      ),
    ).toBe("person");
  });

  test("Manual: you decide every question, even a detail", () => {
    expect(
      loopQuestionDecider(loopWith({ questions: "manual" }), "detail"),
    ).toBe("person");
  });

  test("an approval is never decided by the agent", () => {
    const held = holdQuestion(
      loopWith({ questions: "yolo" }),
      { itemId: "1", question: "Run it?", kind: "approval" },
      T0,
    );
    expect(held.ok && held.question.decidedAlone).toBeUndefined();
  });
});

describe("replanDiff", () => {
  const awaiting = (): LoopState => {
    const base = createLoop(plan("One", "Two", "Three"), {
      now: T0,
      sessionTokens: 0,
    });
    return {
      ...base,
      status: "awaiting_plan",
      items: base.items.map((i, n) => ({
        ...i,
        status:
          n === 0
            ? ("done" as const)
            : n === 1
              ? ("failed" as const)
              : i.status,
      })),
      replanned: { planTexts: ["One", "Two", "Three"] },
    };
  };

  test("is undefined when no re-plan is waiting", () => {
    expect(
      replanDiff(
        createLoop(plan("A"), { now: T0, sessionTokens: 0 }),
        plan("A"),
      ),
    ).toBeUndefined();
  });

  test("a to-do the loop has keeps its state; a reworded one is dropped and added", () => {
    const diff = replanDiff(awaiting(), {
      items: [
        { id: "1", text: "One", status: "pending" },
        { id: "4", text: "Two, first half", status: "pending" },
        { id: "5", text: "Two, second half", status: "pending" },
        { id: "3", text: "Three", status: "pending" },
      ],
      updatedAt: T0.toISOString(),
    });
    expect(diff?.kept).toEqual([
      { text: "One", status: "done" },
      { text: "Three", status: "pending" },
    ]);
    expect(diff?.added).toEqual(["Two, first half", "Two, second half"]);
    expect(diff?.dropped).toEqual([{ text: "Two", status: "failed" }]);
  });

  test("a to-do the old plan had word for word is kept even under a new id", () => {
    const diff = replanDiff(awaiting(), {
      items: [
        { id: "9", text: "Two", status: "pending" },
        { id: "10", text: "Brand new", status: "pending" },
      ],
      updatedAt: T0.toISOString(),
    });
    expect(diff?.kept).toEqual([{ text: "Two", status: "failed" }]);
    expect(diff?.added).toEqual(["Brand new"]);
    expect(diff?.dropped.map((d) => d.text)).toEqual(["One", "Three"]);
  });
});

describe("a held question keeps the choices the agent offered", () => {
  const held = (options: unknown) => {
    const r = holdQuestion(
      loopWith({}),
      {
        itemId: "1",
        question: "Where does the fix land?",
        kind: "blocking",
        options,
      },
      T0,
    );
    if (!r.ok) throw new Error(r.error);
    return r.question;
  };

  test("two to four distinct choices are kept, in order", () => {
    expect(held(["Workspace copy", "Upstream", "Both"]).options).toEqual([
      "Workspace copy",
      "Upstream",
      "Both",
    ]);
  });

  test("duplicates, blanks and non-strings are dropped, and more than four are cut", () => {
    expect(held(["A", " A ", "", 7, "B", "C", "D", "E"]).options).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("fewer than two usable choices is a free-text question", () => {
    expect(held(["Only one"]).options).toBeUndefined();
    expect(held("not a list").options).toBeUndefined();
    expect(held(undefined).options).toBeUndefined();
  });
});
