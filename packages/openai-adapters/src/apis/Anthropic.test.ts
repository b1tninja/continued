import { describe, expect, it } from "vitest";

import { CACHING_STRATEGIES } from "./AnthropicCachingStrategies.js";
import { addCacheControlToLastTwoUserMessages } from "./AnthropicUtils.js";
import { AnthropicApi, anthropicSamplingParams } from "./Anthropic.js";

describe("AnthropicApi", () => {
  describe("_convertBody applies cache_control to last two user messages", () => {
    const api = new AnthropicApi({
      provider: "anthropic",
      apiKey: "test-key",
      cachingStrategy: "systemAndTools",
    });

    it("adds cache_control to the last two user messages", () => {
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "First user message" },
          { role: "assistant", content: "First response" },
          { role: "user", content: "Second user message" },
          { role: "assistant", content: "Second response" },
          { role: "user", content: "Third user message" },
        ],
      });

      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);

      // The last user message (index 4 = "Third user message") should have cache_control
      const lastUserMsg = result.messages[4];
      expect(lastUserMsg.role).toBe("user");
      expect(Array.isArray(lastUserMsg.content)).toBe(true);
      if (Array.isArray(lastUserMsg.content)) {
        const textPart = lastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }

      // The second-to-last user message (index 2 = "Second user message") should also have cache_control
      const secondLastUserMsg = result.messages[2];
      expect(secondLastUserMsg.role).toBe("user");
      expect(Array.isArray(secondLastUserMsg.content)).toBe(true);
      if (Array.isArray(secondLastUserMsg.content)) {
        const textPart = secondLastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }

      // The first user message (index 0 = "First user message") should NOT have cache_control
      const firstUserMsg = result.messages[0];
      expect(firstUserMsg.role).toBe("user");
      expect(Array.isArray(firstUserMsg.content)).toBe(true);
      if (Array.isArray(firstUserMsg.content)) {
        const textPart = firstUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toBeUndefined();
      }
    });

    it("handles conversations with only one user message", () => {
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Only user message" },
        ],
      });

      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);

      const userMsg = result.messages[0];
      expect(userMsg.role).toBe("user");
      expect(Array.isArray(userMsg.content)).toBe(true);
      if (Array.isArray(userMsg.content)) {
        const textPart = userMsg.content.find((p: any) => p.type === "text");
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }
    });

    it("puts the marker before a task list block at the tail, not on it", () => {
      // The CLI sends the task list as the last user message; the adapter
      // merges it into the preceding user message. It changes between
      // requests, so the marker belongs on the block before it.
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Fix the typo." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "# Hello wrld" },
          {
            role: "user",
            content: ["<task_list>", "[>] step 1", "</task_list>"].join(
              String.fromCharCode(10),
            ),
          },
        ],
      });
      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);

      const last = result.messages.at(-1)!;
      expect(last.role).toBe("user");
      const parts = last.content as any[];
      const taskList = parts.find((p) => p.type === "text");
      const toolResult = parts.find((p) => p.type === "tool_result");
      expect(taskList.text).toContain("<task_list>");
      expect(taskList.cache_control).toBeUndefined();
      expect(toolResult.cache_control).toEqual({ type: "ephemeral" });
      // The first user message is the other of the two marked.
      const first = result.messages[0].content as any[];
      expect(first[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("marks a lone task list block when it is the only block", () => {
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          {
            role: "user",
            content: ["<task_list>", "[ ] a", "</task_list>"].join(
              String.fromCharCode(10),
            ),
          },
        ],
      });
      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);
      const only = (result.messages[0].content as any[])[0];
      expect(only.cache_control).toEqual({ type: "ephemeral" });
    });

    it("marks a pinned message (a fork point) and one trailing message, never the mark itself", () => {
      const result = (api as any)._convertBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "item prompt", x_continue_cache_pin: true },
          { role: "assistant", content: "ok" },
          { role: "user", content: "next" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "last" },
        ],
      });
      const marked = result.messages.map(
        (m: any) => (m.content as any[]).filter((p) => p.cache_control).length,
      );
      expect(marked).toEqual([1, 0, 0, 0, 1]);
      expect(JSON.stringify(result)).not.toContain("x_continue_cache_pin");
      // system + pinned + last = 3 markers (no tools here)
      expect(JSON.stringify(result).split("cache_control").length - 1).toBe(3);
    });

    it("strips the pin mark when the caching strategy is none", () => {
      const quiet = new AnthropicApi({
        provider: "anthropic",
        apiKey: "test-key",
        cachingStrategy: "none",
      });
      const result = (quiet as any)._convertBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: "item prompt", x_continue_cache_pin: true },
          { role: "assistant", content: "ok" },
          { role: "user", content: "next" },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("x_continue_cache_pin");
      expect(JSON.stringify(result)).not.toContain("cache_control");
    });

    it("does not cache user messages when caching strategy is none", () => {
      const api = new AnthropicApi({
        provider: "anthropic",
        apiKey: "test-key",
        cachingStrategy: "none",
      });

      const result = (api as any)._convertBody({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "How are you?" },
        ],
      });

      // No cache_control should be added when strategy is "none"
      const lastUserMsg = result.messages[2];
      expect(lastUserMsg.role).toBe("user");
      if (Array.isArray(lastUserMsg.content)) {
        const textPart = lastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toBeUndefined();
      }
    });
  });

  describe("sampling fields", () => {
    const api = new AnthropicApi({ provider: "anthropic", apiKey: "test-key" });
    const messages = [{ role: "user" as const, content: "Hi" }];

    it("sends temperature or top_p, never both", () => {
      const both = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-5",
        messages,
        temperature: 0.5,
        top_p: 0.9,
      });
      expect(both.temperature).toBe(0.5);
      expect(both.top_p).toBeUndefined();

      const topOnly = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-4-5",
        messages,
        top_p: 0.9,
      });
      expect(topOnly.temperature).toBeUndefined();
      expect(topOnly.top_p).toBe(0.9);
    });

    it("anthropicSamplingParams sends neither with thinking on", () => {
      expect(anthropicSamplingParams(0.5, 0.9, true)).toEqual({});
      expect(anthropicSamplingParams(0.5, 0.9, false)).toEqual({
        temperature: 0.5,
      });
    });
  });
});
