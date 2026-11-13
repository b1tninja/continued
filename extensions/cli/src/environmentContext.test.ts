import { renderEnvironment } from "core/util/environmentPrompt.js";
import type { ChatCompletionMessageParam } from "openai/resources.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENVIRONMENT_BLOCK_OPEN,
  ensureSessionEnvironment,
  environmentContextBlock,
  environmentDisclosure,
  inheritEnvironment,
  resetEnvironmentContextBlock,
  sessionEnvironment,
  setEnvironmentDetail,
  withEnvironmentBlock,
} from "./environmentContext.js";
import { getCurrentSession, startNewSession } from "./session.js";

afterEach(() => resetEnvironmentContextBlock());

describe("the session's environment", () => {
  it("is gathered once, saved on the session and rendered by the renderer", async () => {
    startNewSession();
    const env = await ensureSessionEnvironment();
    expect(getCurrentSession().environment).toBe(env);
    expect(await ensureSessionEnvironment()).toBe(env);
    const block = environmentContextBlock();
    expect(block).toBe(
      renderEnvironment(env.snapshot, { surface: "cli", detail: "standard" })
        .firstMessageBlock,
    );
    expect(block.startsWith(ENVIRONMENT_BLOCK_OPEN)).toBe(true);
    expect(block).toContain(`Today's date: ${env.snapshot.localDay}`);
    expect(block).toContain("Working folder: ");
    expect(block.endsWith("</context>")).toBe(true);
    expect(environmentContextBlock()).toBe(block);
  });

  it("a resumed session keeps the bytes it was saved with", async () => {
    startNewSession();
    const env = await ensureSessionEnvironment();
    const saved = JSON.parse(JSON.stringify(getCurrentSession()));
    const before = environmentDisclosure();
    resetEnvironmentContextBlock();
    // A later day and another folder change nothing for the saved session
    saved.environment.snapshot.workspace.cwd = "/elsewhere";
    startNewSession();
    Object.assign(getCurrentSession(), { environment: saved.environment });
    expect(await ensureSessionEnvironment()).toBe(saved.environment);
    expect(environmentDisclosure().systemLine).toBe(before.systemLine);
    expect(environmentDisclosure().toolSentence).toBe(before.toolSentence);
    expect(env.snapshot.takenAt).toBe(saved.environment.snapshot.takenAt);
    expect(environmentContextBlock()).toContain("/elsewhere");
  });

  it("a new session gathers its own", async () => {
    startNewSession();
    const first = await ensureSessionEnvironment();
    startNewSession();
    const second = await ensureSessionEnvironment();
    expect(second).not.toBe(first);
    expect(getCurrentSession().environment).toBe(second);
  });

  it("the system line and tool sentence are the same before the gather finishes", async () => {
    startNewSession();
    const early = environmentDisclosure(sessionEnvironment());
    await ensureSessionEnvironment();
    const late = environmentDisclosure();
    expect(early.systemLine).toBe(late.systemLine);
    expect(early.toolSentence).toBe(late.toolSentence);
  });

  it("the detail level is frozen with the session", async () => {
    startNewSession();
    setEnvironmentDetail("minimal");
    const env = await ensureSessionEnvironment();
    expect(env.detail).toBe("minimal");
    setEnvironmentDetail("full");
    expect(sessionEnvironment().detail).toBe("minimal");
    expect(environmentContextBlock()).not.toContain("Working folder");
  });

  it("a subagent carries the parent's three strings", () => {
    const parent = {
      systemLine: "<env>\nPlatform: X\n</env>",
      toolSentence: "Runs in X.",
      firstMessageBlock: '<context name="environment">\nX\n</context>',
    };
    inheritEnvironment(parent);
    expect(environmentDisclosure()).toEqual(parent);
    inheritEnvironment(undefined);
    expect(environmentDisclosure()).not.toEqual(parent);
  });
});

describe("withEnvironmentBlock", () => {
  const block = '<context name="environment">\nToday: test\n</context>';

  it("appends the block to the first user message only", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system text" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0]).toEqual({ role: "system", content: "system text" });
    expect(result[1].content).toBe(`first\n\n${block}`);
    expect(result[2]).toEqual({ role: "assistant", content: "reply" });
    expect(result[3].content).toBe("second");
    // The input is left alone: the history must not carry the block
    expect(messages[1].content).toBe("first");
  });

  it("adds a text part when the first user message has parts", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [{ type: "text", text: "look at this" }],
      },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0].content).toEqual([
      { type: "text", text: "look at this" },
      { type: "text", text: block },
    ]);
  });

  it("returns the messages unchanged when there is no user message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "only system" },
    ];
    expect(withEnvironmentBlock(messages, block)).toBe(messages);
  });
});
