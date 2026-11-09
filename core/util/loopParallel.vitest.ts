import { describe, expect, test } from "vitest";
import type { LoopState, TaskItem, TaskPlan } from "../index.js";
import {
  createLoop,
  decideNext,
  filesOverlap,
  finishItemRun,
  finishParallelRun,
  LOOP_MAX_PARALLEL,
  loopItemPrompt,
  loopPlanBlock,
  loopRunKey,
  parallelAllowed,
  parallelWave,
  recordCheck,
  requestStop,
  restoreLoop,
  setLoopParallel,
  startItemRun,
  startParallelRun,
  stopLoop,
  taskPlanWithLoop,
} from "./loopMode.js";
import {
  parsePlanFile,
  serializePlanFile,
  taskPlanFromPlanFile,
} from "./planFile.js";

/* Parallel waves (L4): items with disjoint declared files run at once. */

const T0 = new Date("2026-11-08T10:00:00Z");
const ctx = { now: T0, sessionTokens: 0 };

function plan(...items: (Partial<TaskItem> & { text: string })[]): TaskPlan {
  return {
    items: items.map((item, i) => ({
      id: String(i + 1),
      status: "pending" as const,
      ...item,
    })),
    updatedAt: T0.toISOString(),
  };
}

/** A loop at the Auto level with parallel waves on. */
function waveLoop(p: TaskPlan): LoopState {
  return setLoopParallel(
    createLoop(p, { now: T0, sessionTokens: 0, autonomy: "auto" }),
    true,
  );
}

const status = (loop: LoopState, id: string) =>
  loop.items.find((i) => i.id === id)?.status;

describe("declared files overlap", () => {
  test("the same path, a path under a directory, or a directory a glob covers", () => {
    expect(filesOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(filesOverlap(["src"], ["src/a.ts"])).toBe(true);
    expect(filesOverlap(["src/util/*.ts"], ["src/util/deep/x.ts"])).toBe(true);
    expect(filesOverlap(["**/*.ts"], ["docs/readme.md"])).toBe(true);
    expect(filesOverlap(["src/a/**"], ["src/b/x.ts"])).toBe(false);
  });

  test("disjoint files and directories do not", () => {
    expect(filesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(filesOverlap(["src/a"], ["src/ab"])).toBe(false);
    expect(filesOverlap(["gui/src", "docs"], ["core/util/x.ts"])).toBe(false);
  });
});

describe("which items make a wave", () => {
  test("open items with disjoint files, in plan order, at most the limit", () => {
    const p = plan(
      { text: "A", files: ["a"] },
      { text: "B", files: ["b"] },
      { text: "C", files: ["a/x.ts"] },
      { text: "D", files: ["d"] },
      { text: "E", files: ["e"] },
    );
    const wave = parallelWave(waveLoop(p), p);
    expect(wave.map((t) => t.id)).toEqual(["1", "2", "4"]);
    expect(wave).toHaveLength(LOOP_MAX_PARALLEL);
  });

  test("leaves out items without files, set aside, waiting on others, or marked to run inline", () => {
    const p = plan(
      { text: "No files" },
      { text: "A", files: ["a"] },
      { text: "After A", files: ["b"], after: ["2"] },
      { text: "C", files: ["c"] },
      { text: "D", files: ["d"] },
    );
    let loop = waveLoop(p);
    loop = {
      ...loop,
      items: loop.items.map((i) =>
        i.id === "4"
          ? { ...i, setAside: true }
          : i.id === "5"
            ? { ...i, runInline: true }
            : i,
      ),
    };
    expect(parallelWave(loop, p).map((t) => t.id)).toEqual(["2"]);
  });

  test("counts the wave already running against the limit and its files", () => {
    const p = plan(
      { text: "A", files: ["a"] },
      { text: "B", files: ["a/sub"] },
      { text: "C", files: ["c"] },
    );
    const loop = startParallelRun(waveLoop(p), "1", T0);
    expect(parallelWave(loop, p).map((t) => t.id)).toEqual(["3"]);
  });
});

describe("decideNext with parallel waves", () => {
  const p = plan(
    { text: "A", files: ["a"] },
    { text: "B", files: ["b"] },
    { text: "C" },
  );

  test("two or more items with disjoint files run together; the rest run inline after", () => {
    expect(decideNext(waveLoop(p), p, ctx)).toEqual({
      kind: "run_parallel",
      itemIds: ["1", "2"],
    });
    const soloPlan = plan({ text: "A", files: ["a"] }, { text: "C" });
    expect(decideNext(waveLoop(soloPlan), soloPlan, ctx)).toEqual({
      kind: "run",
      itemId: "1",
    });
  });

  test("off by default, and never under Supervised", () => {
    const off = createLoop(p, { now: T0, sessionTokens: 0, autonomy: "auto" });
    expect(parallelAllowed(off)).toBe(false);
    expect(decideNext(off, p, ctx)).toEqual({ kind: "run", itemId: "1" });
    const supervised = setLoopParallel(
      createLoop(p, { now: T0, sessionTokens: 0, autonomy: "supervised" }),
      true,
    );
    expect(parallelAllowed(supervised)).toBe(false);
    expect(decideNext(supervised, p, ctx)).toEqual({
      kind: "run",
      itemId: "1",
    });
    expect(setLoopParallel(supervised, false).parallelOn).toBeUndefined();
  });

  test("nothing else starts while a wave runs, except a finished item's check", () => {
    let loop = startParallelRun(waveLoop(p), "1", T0);
    loop = startParallelRun(loop, "2", T0);
    expect(decideNext(loop, p, ctx)).toEqual({ kind: "none" });
    const checked = plan(
      { text: "A", files: ["a"], check: "npm test" },
      { text: "B", files: ["b"] },
    );
    let withCheck = startParallelRun(waveLoop(checked), "1", T0);
    withCheck = startParallelRun(withCheck, "2", T0);
    withCheck = finishParallelRun(
      withCheck,
      "1",
      { report: { outcome: "done" } },
      T0,
      { check: "npm test" },
    );
    expect(decideNext(withCheck, checked, ctx)).toEqual({
      kind: "check",
      itemId: "1",
      command: "npm test",
    });
  });
});

describe("a wave's runs", () => {
  const p = plan(
    { text: "A", files: ["a"], check: "npm test -- a" },
    { text: "B", files: ["b"] },
    { text: "C", files: ["c"] },
  );

  function wave(): LoopState {
    let loop = waveLoop(p);
    for (const id of ["1", "2", "3"]) {
      loop = startParallelRun(loop, id, T0, {
        worktree: `/wt/${id}`,
        model: id === "2" ? { title: "Opus" } : undefined,
      });
    }
    return loop;
  }

  test("start: each item runs with an attempt, in its worktree, beside the others", () => {
    const loop = wave();
    expect(loop.status).toBe("running");
    expect(loop.current).toBeUndefined();
    expect(loop.parallel).toEqual([
      { itemId: "1", startedAt: T0.toISOString(), worktree: "/wt/1" },
      { itemId: "2", startedAt: T0.toISOString(), worktree: "/wt/2" },
      { itemId: "3", startedAt: T0.toISOString(), worktree: "/wt/3" },
    ]);
    expect(loop.items.map((i) => [i.status, i.attempts])).toEqual([
      ["running", 1],
      ["running", 1],
      ["running", 1],
    ]);
    expect(loop.items[1].model).toEqual({ title: "Opus" });
    expect(loopRunKey(loop, "2")).toBe(`2:parallel:${T0.toISOString()}`);
    expect(loopRunKey(loop)).toBeUndefined();
  });

  test("finish: reports apply one at a time, in finish order, and the run leaves the wave", () => {
    let loop = wave();
    loop = finishParallelRun(
      loop,
      "2",
      { report: { outcome: "done", summary: "b done", notes: "use npm ci" } },
      T0,
    );
    expect(status(loop, "2")).toBe("done");
    expect(loop.doneThisRound).toBe(1);
    expect(loop.notes).toEqual(["use npm ci"]);
    expect(loop.parallel?.map((r) => r.itemId)).toEqual(["1", "3"]);
    // Its check waits for the harness, in the main checkout, as inline
    loop = finishParallelRun(
      loop,
      "1",
      { report: { outcome: "done", summary: "a done" } },
      T0,
      { check: "npm test -- a" },
    );
    expect(status(loop, "1")).toBe("checking");
    loop = recordCheck(
      loop,
      { status: "passed", command: "npm test -- a", exitCode: 0 },
      T0,
      "1",
    );
    expect(status(loop, "1")).toBe("done");
    expect(loop.doneThisRound).toBe(2);
    expect(loop.parallel?.map((r) => r.itemId)).toEqual(["3"]);
    loop = finishParallelRun(
      loop,
      "3",
      { report: { outcome: "stuck", summary: "no idea" } },
      T0,
    );
    expect(status(loop, "3")).toBe("failed");
    expect(loop.consecutiveFailures).toBe(1);
    expect(loop.parallel).toBeUndefined();
    expect(decideNext(loop, p, ctx).kind).not.toBe("none");
  });

  test("a run that ended without a report counts as an attempt and the item is pending", () => {
    const loop = finishParallelRun(wave(), "3", {}, T0);
    expect(status(loop, "3")).toBe("pending");
    expect(loop.items[2].summary).toBe("The turn ended without finish_item.");
    expect(loop.items[2].attempts).toBe(1);
  });

  test("the questions a worker held are filed as the item's; a blocking one makes it wait", () => {
    const loop = finishParallelRun(
      wave(),
      "3",
      {
        report: { outcome: "waiting", summary: "needs a decision" },
        questions: [
          {
            question: "Item C: keep the old API?",
            kind: "assumption",
            assumption: "yes",
          },
          { question: "Item C: which database?", kind: "blocking" },
        ],
      },
      T0,
    );
    expect(loop.questions.map((q) => [q.itemId, q.kind])).toEqual([
      ["3", "assumption"],
      ["3", "blocking"],
    ]);
    expect(status(loop, "3")).toBe("waiting");
  });

  test("a patch that did not merge sends the item back to run inline, and its next prompt says so", () => {
    let loop = finishParallelRun(
      wave(),
      "2",
      {
        report: { outcome: "done", summary: "b done", notes: "kept" },
        mergeFailed: "b.ts changed in the main checkout",
      },
      T0,
    );
    expect(loop.items[1]).toMatchObject({
      status: "pending",
      runInline: true,
      mergeFailed: "b.ts changed in the main checkout",
      summary:
        "Its changes could not be merged: b.ts changed in the main checkout",
    });
    expect(loop.notes).toEqual(["kept"]);
    expect(loop.doneThisRound).toBe(0);
    // It never joins another wave; it runs inline on the merged tree
    loop = finishParallelRun(loop, "1", { report: { outcome: "done" } }, T0, {
      check: "npm test -- a",
    });
    loop = recordCheck(loop, { status: "passed", command: "x" }, T0, "1");
    loop = finishParallelRun(loop, "3", { report: { outcome: "done" } }, T0);
    expect(parallelWave(loop, p)).toEqual([]);
    expect(decideNext(loop, p, ctx)).toEqual({ kind: "run", itemId: "2" });
    const prompt = loopItemPrompt({
      item: p.items[1],
      answers: [],
      questions: [],
      attempt: 2,
      mergeFailed: loop.items[1].mergeFailed,
    });
    expect(prompt).toContain(
      "could not be merged: b.ts changed in the main checkout",
    );
    expect(prompt).not.toContain("ended without reporting");
    // The inline run clears the mark
    const inline = finishItemRun(startItemRun(loop, "2", 0, T0), {
      outcome: "done",
    });
    expect(inline.items[1].runInline).toBeUndefined();
    expect(inline.items[1].mergeFailed).toBeUndefined();
  });

  test("stop puts every worker's item back to pending; a reload stops a saved wave", () => {
    const loop = wave();
    const stopped = stopLoop(loop, "stopped", "You stopped the loop.");
    expect(stopped.parallel).toBeUndefined();
    expect(stopped.items.map((i) => i.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(requestStop(loop).stopRequested).toBe(true);
    expect(requestStop(loop).status).toBe("running");
    const restored = restoreLoop(JSON.parse(JSON.stringify(loop)));
    expect(restored?.status).toBe("stopped");
    expect(restored?.parallel).toBeUndefined();
  });

  test("the plan block marks the worker's own item and the others running beside it", () => {
    const loop = wave();
    const block = loopPlanBlock({ loop, plan: p, itemId: "2" });
    expect(block).toContain("[>] 2. B  <- this item (attempt 1 of");
    expect(block).toContain(
      "[>] 1. A (running now, in its own copy of the repository)",
    );
    expect(block).toContain(
      "[>] 3. C (running now, in its own copy of the repository)",
    );
    // Once in the instructions, once on the item
    expect(block.split("<- this item (attempt")).toHaveLength(2);
  });

  test("the worker's prompt names its worktree and files and says nobody answers", () => {
    const prompt = loopItemPrompt({
      item: p.items[0],
      answers: [],
      questions: [],
      attempt: 1,
      worker: { worktree: "/wt/1", files: ["a"] },
    });
    expect(prompt).toContain("its own copy of the repository at /wt/1");
    expect(prompt).toContain("Change only the files this item declares: a");
    expect(prompt).toContain("Nobody answers questions during this run");
    expect(prompt).toContain("Do not commit, push or edit the plan file");
    // The level line stays last, so the plan block after it never moves
    expect(prompt.trim().endsWith("your default.")).toBe(true);
  });

  test("the task list shows where a worker runs", () => {
    const synced = taskPlanWithLoop(p, wave());
    expect(synced.items[0]).toMatchObject({
      status: "in_progress",
      note: "Running in its own worktree, beside other items",
    });
  });
});

describe("the plan file's files: line", () => {
  const file = [
    "# Retry",
    "",
    "## To-dos",
    "",
    "- [ ] Add a retry helper <!-- id: 1 -->",
    "  check: npm test -- retry",
    "  files: src/retry.ts, src/retry.test.ts",
    "- [ ] Document it <!-- id: 2 -->",
    "  files: docs/**",
    "",
  ].join("\n");

  test("is read as the item's files and written back as it was", () => {
    const read = taskPlanFromPlanFile(file, undefined, T0);
    if (!read.ok) throw new Error(read.error);
    expect(read.plan.items[0].files).toEqual([
      "src/retry.ts",
      "src/retry.test.ts",
    ]);
    expect(read.plan.items[1].files).toEqual(["docs/**"]);
    const doc = parsePlanFile(file);
    expect(
      serializePlanFile({
        title: doc.title,
        body: doc.body,
        items: read.plan.items,
      }),
    ).toBe(file);
  });
});
