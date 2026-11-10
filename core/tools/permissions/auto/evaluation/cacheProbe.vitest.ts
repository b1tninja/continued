import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildHttpCall,
  buildOrderedRequest,
  buildShippedRequest,
  parseReply,
  redact,
  runProbe,
  sessionInput,
  summarizeProbe,
  toCsv,
  trimInSteps,
  type ProbeRequest,
} from "./cacheProbe";
import { buildReviewMessages, REVIEWER_SYSTEM_PROMPT } from "../prompt";

const SECRET = "sk-test-0123456789abcdef";
const nonceA = "aaaaaaaaaaaaaaaa";
const nonceB = "bbbbbbbbbbbbbbbb";

describe("reviewer prompt: where the nonce sits (characterisation)", () => {
  it("leaves the first user block free of the nonce and puts it in the second", () => {
    const input = sessionInput(5);
    const one = buildReviewMessages({ ...input, nonce: nonceA })[1].content;
    const two = buildReviewMessages({ ...input, nonce: nonceB })[1].content;
    const split = (s: unknown) => String(s).split("\n\n");
    expect(split(one)[0]).toContain("[[USER-MESSAGES]]");
    expect(split(one)[0]).toBe(split(two)[0]);
    expect(split(one)[1]).not.toBe(split(two)[1]);
    expect(split(one)[1]).toContain(nonceA);
  });

  it("shifts every earlier-call line once the 30-call window is full", () => {
    const a = sessionInput(40).history.toolCalls.slice(-30);
    const b = sessionInput(41).history.toolCalls.slice(-30);
    expect(b[0]).not.toEqual(a[0]);
  });
});

describe("trimInSteps", () => {
  it("moves the start only in whole steps, so the head of the list is stable", () => {
    const list = Array.from({ length: 100 }, (_, i) => i);
    const starts = new Set<number>();
    for (let n = 31; n <= 100; n++) {
      const kept = trimInSteps(list.slice(0, n), 30, 10);
      expect(kept.length).toBeLessThanOrEqual(30);
      expect(kept.length).toBeGreaterThanOrEqual(21);
      starts.add(kept[0]);
    }
    expect([...starts]).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("returns a short list unchanged", () => {
    expect(trimInSteps([1, 2], 30, 10)).toEqual([1, 2]);
  });
});

describe("request shapes", () => {
  const input = sessionInput(45);

  it("arm A is the shipped prompt with no markers", () => {
    const req = buildShippedRequest(input, nonceA, false);
    const http = buildHttpCall(
      { provider: "anthropic", model: "m" },
      req,
      SECRET,
    );
    expect(JSON.stringify(http.body)).not.toContain("cache_control");
    expect(req.system).toBe(REVIEWER_SYSTEM_PROMPT);
  });

  it("arm C orders static, session, history, call, with the call fence last", () => {
    const req = buildOrderedRequest(input, nonceA, nonceB);
    expect(req.blocks).toHaveLength(3);
    expect(req.blocks.map((b) => !!b.cache)).toEqual([true, true, false]);
    expect(req.blocks[0].text).toContain("ENVIRONMENT");
    expect(req.blocks[1].text).toContain("[[USER-MESSAGES]]");
    expect(req.blocks[2].text).toContain(`TOOL-CALL ${nonceB}`);
    expect(
      req.blocks[2].text.endsWith("Reply with the JSON object only."),
    ).toBe(true);
    // the stable blocks never contain the per-call nonce
    expect(req.blocks[0].text + req.blocks[1].text).not.toContain(nonceB);
  });

  it("arm C's session block is identical for two calls, and its history block too within a step", () => {
    const one = buildOrderedRequest(sessionInput(40), nonceA, "c".repeat(16));
    const two = buildOrderedRequest(sessionInput(41), nonceA, "d".repeat(16));
    expect(one.blocks[0].text).toBe(two.blocks[0].text);
  });

  it("carries the same environment lines as the shipped prompt", () => {
    const shipped = buildShippedRequest(input, nonceA, false).blocks[0].text;
    const ordered = buildOrderedRequest(input, nonceA, nonceB).blocks[0].text;
    for (const line of [
      "Operating system: linux",
      "Trusted domains:",
      "Production markers",
    ]) {
      expect(shipped).toContain(line);
      expect(ordered).toContain(line);
    }
  });

  const req: ProbeRequest = {
    system: "sys",
    systemCache: true,
    blocks: [{ text: "one", cache: true }, { text: "two" }],
  };

  it("anthropic: markers on the system block and the marked user block, key in a header only", () => {
    const http = buildHttpCall(
      { provider: "anthropic", model: "m", ttl: "1h" },
      req,
      SECRET,
    );
    const body = http.body as any;
    expect(body.system[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(body.messages[0].content[0].cache_control).toBeDefined();
    expect(body.messages[0].content[1].cache_control).toBeUndefined();
    expect(http.headers["x-api-key"]).toBe(SECRET);
    expect(JSON.stringify(http.body)).not.toContain(SECRET);
  });

  it("bedrock: cachePoint after the marked text, bearer in a header only, no ttl by default", () => {
    const http = buildHttpCall(
      {
        provider: "bedrock",
        model: "us.anthropic.claude-x:0",
        region: "eu-west-1",
      },
      req,
      SECRET,
    );
    const body = http.body as any;
    expect(http.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-x%3A0/converse",
    );
    expect(body.system[1]).toEqual({ cachePoint: { type: "default" } });
    expect(body.messages[0].content.map((c: any) => Object.keys(c)[0])).toEqual(
      ["text", "cachePoint", "text"],
    );
    expect(http.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(http.body)).not.toContain(SECRET);
  });

  it("openai: no markers", () => {
    const http = buildHttpCall({ provider: "openai", model: "m" }, req, SECRET);
    expect(JSON.stringify(http.body)).not.toMatch(/cache/);
  });
});

describe("parseReply reads each provider's cache fields", () => {
  it("anthropic", () => {
    const r = parseReply("anthropic", {
      content: [{ type: "text", text: "{}" }],
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 1800,
        cache_creation_input_tokens: 200,
      },
    });
    expect(r.usage).toEqual({
      input: 2050,
      cacheRead: 1800,
      cacheWrite: 200,
      uncached: 50,
    });
  });

  it("bedrock", () => {
    const r = parseReply("bedrock", {
      output: { message: { content: [{ text: "hi" }] } },
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 90,
        cacheWriteInputTokens: 0,
      },
    });
    expect(r.text).toBe("hi");
    expect(r.usage.input).toBe(100);
    expect(r.usage.cacheRead).toBe(90);
  });

  it("openai counts input as the total and cached as a part of it", () => {
    const r = parseReply("openai", {
      choices: [{ message: { content: "x" } }],
      usage: {
        prompt_tokens: 2048,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });
    expect(r.usage).toEqual({
      input: 2048,
      cacheRead: 1920,
      cacheWrite: 0,
      uncached: 128,
    });
  });
});

function stubFetch(
  respond: (
    call: number,
    body: any,
  ) => { status?: number; json?: unknown; text?: string },
) {
  let n = 0;
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const r = respond(++n, JSON.parse(String(init?.body)));
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => r.json,
      text: async () => r.text ?? "",
    } as Response;
  });
}

const allow = JSON.stringify({ decision: "allow", reason: "ok" });

describe("runProbe with a stubbed provider", () => {
  it("makes calls per arm, reads cache usage and summarises read share", async () => {
    const fetchImpl = stubFetch((n) => ({
      json: {
        content: [{ type: "text", text: allow }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: n % 3 === 1 ? 0 : 900,
          cache_creation_input_tokens: 0,
        },
      },
    }));
    const sleeps: number[] = [];
    const rows = await runProbe({
      target: { provider: "anthropic", model: "m" },
      credential: SECRET,
      calls: 3,
      gapMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      runId: "test",
    });
    expect(rows).toHaveLength(9);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(sleeps).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
    const summary = summarizeProbe(rows);
    expect(summary.map((s) => s.arm)).toEqual(["A", "B", "C"]);
    // calls 2 and 3 of each arm are warm reads of 900 in 1000
    expect(summary[0].readShare).toBeCloseTo(0.9, 1);
    expect(summary[1].agreementWithA).toBe(1);
    expect(summary[1].loosened).toBe(0);
  });

  it("gives each arm its own system salt so arms cannot share cache", async () => {
    const systems: string[] = [];
    const fetchImpl = stubFetch((_n, body) => {
      systems.push(body.system[0].text);
      return { json: { content: [{ type: "text", text: allow }], usage: {} } };
    });
    await runProbe({
      target: { provider: "anthropic", model: "m" },
      credential: SECRET,
      calls: 1,
      gapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runId: "r1",
    });
    expect(new Set(systems).size).toBe(3);
    expect(systems[0]).toContain("[probe r1 arm A]");
  });

  it("counts a failed call, keeps going, and never lets the credential into a row", async () => {
    const fetchImpl = stubFetch((n) =>
      n === 2
        ? { status: 401, text: `bad key ${SECRET}` }
        : { json: { content: [{ type: "text", text: allow }], usage: {} } },
    );
    const rows = await runProbe({
      target: { provider: "anthropic", model: "m" },
      credential: SECRET,
      arms: ["A"],
      calls: 3,
      gapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(rows[1].status).toBe(401);
    expect(toCsv(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(summarizeProbe(rows)[0].failed).toBe(1);
  });

  it("redacts a credential thrown inside a network error", async () => {
    const rows = await runProbe({
      target: { provider: "openai", model: "m" },
      credential: SECRET,
      arms: ["A"],
      calls: 1,
      gapMs: 0,
      fetchImpl: (async () => {
        throw new Error(`connect failed for ${SECRET}`);
      }) as unknown as typeof fetch,
    });
    expect(rows[0].error).toBe("connect failed for [credential]");
  });

  it("flags an arm that answers more loosely than arm A", async () => {
    const ask = JSON.stringify({
      decision: "ask",
      category: "uncertain",
      reason: "x",
    });
    const fetchImpl = stubFetch((n) => ({
      json: {
        content: [{ type: "text", text: n <= 2 ? ask : allow }],
        usage: {},
      },
    }));
    const rows = await runProbe({
      target: { provider: "anthropic", model: "m" },
      credential: SECRET,
      arms: ["A", "B"],
      calls: 2,
      gapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const b = summarizeProbe(rows).find((s) => s.arm === "B")!;
    expect(b.loosened).toBe(2);
  });
});

describe("redact", () => {
  it("removes every occurrence", () => {
    expect(redact(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(
      "a [credential] b [credential]",
    );
  });
});

describe("scripts/reviewerCacheProbe.mjs", () => {
  const script = resolve(
    __dirname,
    "../../../../scripts/reviewerCacheProbe.mjs",
  );
  function run(args: string[], env: Record<string, string> = {}) {
    const clean = { ...process.env };
    for (const k of Object.keys(clean)) {
      if (k.startsWith("REVIEWER_PROBE_") || k.endsWith("_API_KEY")) {
        delete clean[k];
      }
    }
    return spawnSync(process.execPath, [script, ...args], {
      env: { ...clean, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("prints usage", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--run");
  });

  it("without --run sends nothing, says so, and does not print the key", () => {
    const r = run(["--provider", "anthropic", "--model", "m"], {
      ANTHROPIC_API_KEY: SECRET,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Nothing was sent");
    expect(r.stderr).toContain("ANTHROPIC_API_KEY is set");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it("with --run and no key stops before any request", () => {
    const r = run(["--provider", "anthropic", "--model", "m", "--run"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects a bad arm and an unknown option", () => {
    expect(
      run(["--provider", "openai", "--model", "m", "--arms", "Z"]).status,
    ).toBe(2);
    expect(run(["--nope"]).status).toBe(2);
  });
});
