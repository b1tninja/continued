import { afterEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import {
  coreLoopWorktreeOps,
  localPathUri,
  loopWorktreeOps,
  setLoopWorktreeOps,
} from "./loopWorktrees";

const REPO = "/Users/user/repo";
const INFO = {
  path: "/Users/user/.continuous/worktrees/repo/plan-1",
  branch: "continued/loop-plan-1",
  baseline: "abc123",
};

/** A messenger that answers the loop/worktree messages and records them. */
function messenger() {
  const asked: { type: string; data: unknown }[] = [];
  const m = new MockIdeMessenger();
  const record =
    <T>(type: string, answer: T) =>
    async (data: unknown) => {
      asked.push({ type, data });
      return answer;
    };
  m.responseHandlers["loop/worktreeCreate"] = record("create", INFO);
  m.responseHandlers["loop/worktreePatch"] = record("patch", "the patch");
  m.responseHandlers["loop/worktreeRemove"] = record("remove", undefined);
  m.responseHandlers["loop/dirtyFiles"] = record("dirty", ["src/a.ts"]);
  return { m, asked };
}

describe("the loop's worktrees through core", () => {
  afterEach(() => setLoopWorktreeOps());

  it("asks core for each step with the repository, the plan's slug and the item", async () => {
    const { m, asked } = messenger();
    expect(await coreLoopWorktreeOps.create(m, REPO, "plan", "1")).toEqual(
      INFO,
    );
    expect(await coreLoopWorktreeOps.patch(m, INFO)).toBe("the patch");
    expect(await coreLoopWorktreeOps.dirty(m, REPO)).toEqual(["src/a.ts"]);
    await coreLoopWorktreeOps.remove(m, REPO, INFO);
    expect(asked).toEqual([
      { type: "create", data: { repo: REPO, slug: "plan", itemId: "1" } },
      { type: "patch", data: { path: INFO.path, baseline: INFO.baseline } },
      { type: "dirty", data: { repo: REPO } },
      {
        type: "remove",
        data: { repo: REPO, path: INFO.path, branch: INFO.branch },
      },
    ]);
  });

  it("an applied patch is ok; a refusal carries core's reason", async () => {
    const { m } = messenger();
    m.responseHandlers["loop/worktreeApply"] = async (data: any) =>
      data.touchedSince?.length
        ? {
            applied: false,
            reason: "touched",
            files: data.touchedSince,
            message: `changed in the main checkout since the wave started: ${data.touchedSince.join(", ")}`,
          }
        : { applied: true, files: ["src/a.ts"] };
    expect(await coreLoopWorktreeOps.apply(m, REPO, "p", [])).toEqual({
      ok: true,
    });
    expect(await coreLoopWorktreeOps.apply(m, REPO, "p", ["src/a.ts"])).toEqual(
      {
        ok: false,
        reason: "changed in the main checkout since the wave started: src/a.ts",
      },
    );
  });

  it("a failed message is an error, not a silent empty answer", async () => {
    const m = new MockIdeMessenger();
    m.responseHandlers["loop/worktreePatch"] = async () => {
      throw new Error("fatal: not a git repository");
    };
    await expect(coreLoopWorktreeOps.patch(m, INFO)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("is the default, and a replacement is undone by a reset", () => {
    expect(loopWorktreeOps()).toBe(coreLoopWorktreeOps);
    const fake = { ...coreLoopWorktreeOps };
    setLoopWorktreeOps(fake);
    expect(loopWorktreeOps()).toBe(fake);
    setLoopWorktreeOps();
    expect(loopWorktreeOps()).toBe(coreLoopWorktreeOps);
  });
});

describe("localPathUri", () => {
  it("makes a file URI from a posix or a Windows path, and leaves a URI alone", () => {
    expect(localPathUri("/Users/user/repo")).toBe("file:///Users/user/repo");
    expect(localPathUri("C:\\Users\\user\\repo")).toBe(
      "file:///C:/Users/user/repo",
    );
    expect(localPathUri("file:///x")).toBe("file:///x");
  });
});
