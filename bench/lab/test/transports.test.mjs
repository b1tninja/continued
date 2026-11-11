import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { buildCacheReport, expandCache, runCache } from "../lib/cache.mjs";
import { Budget } from "../lib/guards.mjs";
import { LabError } from "../lib/ollama.mjs";
import { assertWritable, roots as makeRoots } from "../lib/paths.mjs";
import { cfgTag } from "../lib/run.mjs";
import {
  buildArgs,
  killTree,
  preflight,
  startServer,
  ServerError,
} from "../lib/server.mjs";
import { loadSuite } from "../lib/suites.mjs";
import {
  Engine,
  buildRequest,
  renderChatml,
  toolChoiceBody,
} from "../lib/transports.mjs";
import { startFake } from "./fakeOllama.mjs";
import { startFakeLlama } from "./fakeLlama.mjs";

const tools = [
  {
    name: "read_file",
    description: "r",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];
const msgs = [
  { role: "system", content: "sys" },
  { role: "user", content: "Read the file a.txt." },
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-tr-"));
const fresh = () => {
  const dir = tmp();
  return makeRoots({
    results: path.join(dir, "r"),
    profiles: path.join(dir, "p"),
    tmp: dir,
    logs: path.join(dir, "logs"),
  });
};

test("requests: each surface builds its own body, options and notes", () => {
  const base = {
    model: "m",
    messages: msgs,
    tools,
    temperature: 0.2,
    numPredict: 99,
    seed: 7,
    toolChoice: "required",
    numCtx: 4096,
  };
  const chat = buildRequest("ollama-chat", { ...base, think: "off" });
  assert.equal(chat.path, "/api/chat");
  assert.equal(chat.body.think, false);
  assert.deepEqual(chat.body.options, {
    temperature: 0.2,
    num_predict: 99,
    num_ctx: 4096,
    seed: 7,
  });
  assert.equal(chat.body.tool_choice, undefined);
  assert.ok(chat.notes.some((n) => /tool_choice/.test(n)));
  assert.equal(
    buildRequest("ollama-chat", { ...base, think: "default" }).body.think,
    undefined,
  );

  const v1 = buildRequest("ollama-v1", { ...base, think: "off", stream: true });
  assert.equal(v1.path, "/v1/chat/completions");
  assert.equal(v1.body.tool_choice, "required");
  assert.equal(v1.body.max_tokens, 99);
  assert.equal(v1.body.reasoning_effort, "none");
  assert.deepEqual(v1.body.stream_options, { include_usage: true });
  assert.ok(v1.notes.some((n) => /num_ctx/.test(n)));

  const oa = buildRequest("openai-chat", {
    ...base,
    think: "on",
    toolChoice: "read_file",
  });
  assert.deepEqual(oa.body.tool_choice, {
    type: "function",
    function: { name: "read_file" },
  });
  assert.deepEqual(oa.body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(
    buildRequest("openai-chat", { ...base, think: "high" }).body
      .reasoning_effort,
    "high",
  );
  assert.equal(
    buildRequest("openai-chat", { ...base, numPredict: -1 }).body.max_tokens,
    undefined,
  );

  const raw = buildRequest("ollama-raw", { ...base, style: "codeblock" });
  assert.equal(raw.path, "/api/generate");
  assert.equal(raw.body.raw, true);
  assert.equal(raw.body.tools, undefined);
  assert.match(raw.body.prompt, /^<\|im_start\|>system\nsys\n\n/);
  assert.match(raw.body.prompt, /<\|im_start\|>assistant\n$/);
  assert.equal(toolChoiceBody("none"), "none");
  assert.equal(
    renderChatml([{ role: "user", content: "x" }]),
    "<|im_start|>user\nx<|im_end|>\n<|im_start|>assistant\n",
  );
  assert.deepEqual(
    buildRequest("openai-chat", {
      ...base,
      bodyExtra: { reasoning_format: "none" },
    }).body.reasoning_format,
    "none",
  );
  assert.throws(() => buildRequest("nope", base), /unknown --api/);
});

test("cfgTag: the default configuration keeps the old key, others differ", () => {
  assert.equal(cfgTag(), "");
  assert.equal(cfgTag({ api: "ollama-chat" }), "");
  assert.equal(
    cfgTag({ api: "openai-chat", think: "on", numPredict: 2048 }),
    "@openai-chat,think=on,np=2048",
  );
});

test("openai-chat against a fake llama-server: whole and streamed, tool calls, reasoning, timings", async () => {
  const fake = await startFakeLlama({
    script: (b) =>
      b.tools?.length
        ? {
            reasoning: "thinking...",
            tool_calls: [{ name: "read_file", arguments: { path: "a.txt" } }],
          }
        : { content: "Paris" },
  });
  try {
    const c = new Engine({ api: "openai-chat", baseUrl: fake.url });
    for (const stream of [false, true]) {
      const r = await c.chat({
        model: "m",
        messages: msgs,
        tools,
        stream,
        think: "on",
      });
      assert.deepEqual(r.toolCalls, [
        { name: "read_file", arguments: '{"path":"a.txt"}' },
      ]);
      assert.equal(r.thinking, "thinking...");
      assert.equal(r.meta.reasoningField, "reasoning_content");
      assert.equal(r.doneReason, "tool_calls");
      assert.equal(r.usage.outputTokens, 7);
      assert.equal(r.usage.predictedPerSecond, 100);
      assert.equal(typeof r.usage.cachedTokens, "number");
      assert.equal(typeof r.usage.promptEvalTokens, "number");
      assert.equal(
        r.usage.promptTokens,
        r.usage.cachedTokens + r.usage.promptEvalTokens,
      );
      if (stream) assert.ok(r.usage.ttftMs >= 0 && r.chunks);
    }
    const sent = fake.state.requests.at(-1);
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: true });
    const plain = await c.chat({ model: "m", messages: msgs, stream: true });
    assert.equal(plain.text, "Paris");
    assert.equal(plain.doneReason, "stop");
    const d = await c.describe("m");
    assert.equal(d.build, "b12206-fake");
    assert.equal(d.nCtx, 16384);
    assert.match(d.chatTemplateSha, /^[0-9a-f]{16}$/);
  } finally {
    await fake.close();
  }
});

test("a reasoning field named `reasoning` or an http error body is read, not guessed", async () => {
  const f = await startFakeLlama({
    reasoningField: "reasoning",
    script: () => ({ content: "x", reasoning: "hmm" }),
  });
  try {
    const r = await new Engine({ api: "openai-chat", baseUrl: f.url }).chat({
      model: "m",
      messages: msgs,
    });
    assert.equal(r.thinking, "hmm");
    assert.equal(r.meta.reasoningField, "reasoning");
  } finally {
    await f.close();
  }
  const bad = await startFakeLlama({
    script: () => ({ status: 400, error: "tool_choice unsupported" }),
  });
  try {
    await assert.rejects(
      new Engine({ api: "openai-chat", baseUrl: bad.url }).chat({
        model: "m",
        messages: msgs,
        toolChoice: "required",
        tools,
      }),
      (e) => e instanceof LabError && /unsupported/.test(e.message),
    );
  } finally {
    await bad.close();
  }
});

test("llamacpp-raw renders with /apply-template and reads cache counters", async () => {
  const fake = await startFakeLlama();
  try {
    const c = new Engine({ api: "llamacpp-raw", baseUrl: fake.url });
    const r1 = await c.chat({
      model: "m",
      messages: msgs,
      tools,
      options: { num_predict: 8 },
    });
    const r2 = await c.chat({
      model: "m",
      messages: msgs,
      tools,
      options: { num_predict: 8 },
    });
    assert.equal(r1.text, "Paris");
    assert.equal(r1.doneReason, "eos");
    assert.equal(r1.usage.cachedTokens, 0);
    assert.ok(r2.usage.cachedTokens > 0);
    const [t, comp] = fake.state.requests.slice(0, 2);
    assert.match(t.applyTemplate.messages[0].content, /sys\n\n/);
    assert.equal(comp.completion.n_predict, 8);
    assert.match(comp.completion.prompt, /^<system>/);
  } finally {
    await fake.close();
  }
});

test("ollama-v1 and ollama-raw against the fake Ollama", async () => {
  const fake = await startFake();
  try {
    const v1 = new Engine({ api: "ollama-v1", baseUrl: fake.url });
    const r = await v1.chat({
      model: "fake-small:1b",
      messages: msgs,
      tools,
      toolChoice: "auto",
      stream: true,
    });
    assert.deepEqual(r.toolCalls, [
      { name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
    assert.equal(fake.state.v1[0].tool_choice, "auto");
    assert.equal(r.usage.cachedTokens, undefined);
    assert.ok(r.usage.promptTokens > 0);
    const raw = new Engine({ api: "ollama-raw", baseUrl: fake.url });
    for (const stream of [false, true]) {
      const g = await raw.chat({
        model: "fake-small:1b",
        messages: msgs,
        stream,
        options: { num_predict: 5 },
      });
      assert.equal(g.text, "Paris");
      assert.equal(g.usage.promptTokens, 30);
      assert.equal(g.usage.promptEvalMs, 5);
      assert.equal(g.doneReason, "stop");
    }
    assert.equal(fake.state.generates[0].raw, true);
    assert.equal(fake.state.generates[0].options.num_predict, 5);
    const chat = new Engine({ api: "ollama-chat", baseUrl: fake.url });
    const c = await chat.chat({
      model: "fake-small:1b",
      messages: msgs,
      tools,
      seed: 3,
      think: "default",
    });
    assert.equal(c.toolCalls[0].name, "read_file");
    assert.equal(fake.state.chats.at(-1).options.seed, 3);
    assert.equal("think" in fake.state.chats.at(-1), false);
    const d = await chat.describe("fake-small:1b");
    assert.equal(d.version, "0.0.0-fake");
  } finally {
    await fake.close();
  }
});

test("guards: loopback only, ps asks Ollama while a llama-server run is planned, write allowlist", async () => {
  assert.throws(
    () => new Engine({ api: "openai-chat", baseUrl: "http://192.0.2.1:8080" }),
    /non-loopback/,
  );
  assert.throws(
    () =>
      new Engine({
        api: "openai-chat",
        baseUrl: "http://127.0.0.1:8080",
        ollamaUrl: "http://192.0.2.1:11434",
      }),
    /non-loopback/,
  );
  assert.doesNotThrow(
    () =>
      new Engine({
        api: "openai-chat",
        baseUrl: "http://192.0.2.1:8080",
        allowRemote: true,
        ollamaUrl: "http://127.0.0.1:1",
      }),
  );
  const ollama = await startFake({ loaded: ["fake-big:70b"] });
  try {
    const e = new Engine({
      api: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      ollamaUrl: ollama.url,
    });
    assert.deepEqual(
      (await e.ps()).models.map((m) => m.name),
      ["fake-big:70b"],
    );
  } finally {
    await ollama.close();
  }
  const r = fresh();
  const other = tmp();
  assert.throws(
    () => assertWritable(path.join(other, "x"), r),
    /refusing to write/,
  );
  const allowed = makeRoots({ results: r.results, tmp: r.tmp, allow: [other] });
  assert.equal(
    assertWritable(path.join(other, "x"), allowed),
    path.join(other, "x"),
  );
  assert.throws(
    () => assertWritable(path.join(other, "..", "x"), allowed),
    /refusing to write/,
  );
});

// --- the server helper -------------------------------------------------------

test("server args: safe flag set, no host or port override through extra", () => {
  const a = buildArgs({
    gguf: "M:/g/x.gguf",
    port: 8081,
    ctx: 8192,
    chatTemplate: "chatml",
    cacheReuse: 256,
    extra: ["--no-mmap"],
  });
  assert.deepEqual(a.slice(0, 4), ["-m", "M:/g/x.gguf", "--host", "127.0.0.1"]);
  for (const f of ["--jinja", "--no-webui"]) assert.ok(a.includes(f));
  assert.equal(a[a.indexOf("-ngl") + 1], "99");
  assert.equal(a[a.indexOf("-c") + 1], "8192");
  assert.equal(a[a.indexOf("--chat-template") + 1], "chatml");
  assert.equal(a[a.indexOf("--cache-reuse") + 1], "256");
  assert.equal(a[a.indexOf("-a") + 1], "x");
  assert.equal(a.at(-1), "--no-mmap");
  assert.throws(
    () => buildArgs({ gguf: "g", extra: ["--host", "0.0.0.0"] }),
    ServerError,
  );
  assert.throws(
    () => buildArgs({ gguf: "g", extra: ["--port=1"] }),
    ServerError,
  );
  assert.throws(() => buildArgs({}), /GGUF/);
});

test("killTree: taskkill /T /F on Windows, SIGKILL elsewhere", () => {
  const calls = [];
  killTree(42, { platform: "win32", exec: (...a) => calls.push(a) });
  assert.deepEqual(calls[0].slice(0, 2), [
    "taskkill",
    ["/PID", "42", "/T", "/F"],
  ]);
  const sig = [];
  killTree(42, { platform: "linux", kill: (...a) => sig.push(a) });
  assert.deepEqual(sig[0], [42, "SIGKILL"]);
  assert.equal(killTree(0), false);
});

const gpu = (freeGB) => () => [
  { name: "g", totalGB: 32, usedGB: 32 - freeGB, freeGB },
];
const GGUF = () => {
  const f = path.join(tmp(), "m.gguf");
  fs.writeFileSync(f, Buffer.alloc(1000));
  return f;
};
const pre = (o) => ({
  exe: process.execPath,
  port: 1,
  ollamaUrl: "http://127.0.0.1:1",
  readGpu: gpu(20),
  ...o,
});

test("server preflight: refuses on VRAM, unreadable nvidia-smi, loaded Ollama model, busy port, missing files", async () => {
  const logDir = tmp();
  const g = GGUF();
  assert.deepEqual(await preflight(pre({ gguf: g, logDir })), []);
  assert.match(
    (
      await preflight(
        pre({ gguf: g, logDir, readGpu: gpu(1), fileSize: () => 20e9 }),
      )
    ).join(),
    /needs about 22\.0 GB/,
  );
  assert.match(
    (
      await preflight(pre({ gguf: g, logDir, readGpu: () => undefined }))
    ).join(),
    /nvidia-smi is unavailable/,
  );
  assert.equal(
    (
      await preflight(
        pre({ gguf: g, logDir, readGpu: () => undefined, checkVram: false }),
      )
    ).length,
    0,
  );
  assert.match(
    (
      await preflight(pre({ gguf: "nope.gguf", logDir, exe: "nope.exe" }))
    ).join(),
    /not found/,
  );
  const ollama = await startFake({ loaded: ["qwen3.6:27b"] });
  const llama = await startFakeLlama();
  try {
    assert.match(
      (await preflight(pre({ gguf: g, logDir, ollamaUrl: ollama.url }))).join(),
      /Ollama has a model loaded \(qwen3\.6:27b\)/,
    );
    assert.match(
      (await preflight(pre({ gguf: g, logDir, port: llama.port }))).join(),
      /already answers/,
    );
  } finally {
    await ollama.close();
    await llama.close();
  }
  fs.writeFileSync(path.join(logDir, "llama-server.pid"), String(process.pid));
  assert.match(
    (await preflight(pre({ gguf: g, logDir }))).join(),
    /still running/,
  );
});

function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.exitCode = null;
  return c;
}

test("server start: waits for /health 200 through 503, logs under the log folder, stops by killing the tree", async () => {
  const llama = await startFakeLlama({ readyAfter: 2 });
  const roots = fresh();
  const spawned = [];
  const killed = [];
  try {
    const h = await startServer(
      {
        gguf: GGUF(),
        exe: process.execPath,
        port: llama.port,
        ctx: 4096,
        ollamaUrl: "http://127.0.0.1:1",
        readGpu: gpu(20),
        pollMs: 1,
      },
      roots,
      {
        spawn: (exe, args, o) => (spawned.push({ exe, args, o }), fakeChild()),
        kill: (pid) => killed.push(pid),
        wait: async () => {},
        preflight: { readGpu: gpu(20), port: 0 },
        install: false,
      },
    );
    assert.ok(llama.state.health >= 3);
    assert.equal(h.pid, 4242);
    assert.ok(h.logFile.startsWith(roots.logs));
    assert.ok(fs.existsSync(path.join(roots.logs, "llama-server.pid")));
    assert.ok(fs.readFileSync(h.logFile, "utf8").includes("--jinja"));
    fs.appendFileSync(h.logFile, "srv  init: Chat format: Hermes 2 Pro\n");
    assert.equal(h.chatFormat(), "Hermes 2 Pro");
    h.stop();
    h.stop();
    assert.deepEqual(killed, [4242]);
    assert.ok(!fs.existsSync(path.join(roots.logs, "llama-server.pid")));
    assert.equal(spawned[0].o.windowsHide, true);
  } finally {
    await llama.close();
  }
});

test("server start: a child that exits early, or never gets ready, is killed and reported", async () => {
  const roots = fresh();
  const killed = [];
  const early = fakeChild(1);
  early.exitCode = 3;
  await assert.rejects(
    startServer(
      {
        gguf: GGUF(),
        exe: process.execPath,
        port: 1,
        pollMs: 1,
        ollamaUrl: "http://127.0.0.1:1",
      },
      roots,
      {
        spawn: () => early,
        kill: (p) => killed.push(p),
        wait: async () => {},
        preflight: { readGpu: gpu(20) },
        install: false,
      },
    ),
    /exited with code 3/,
  );
  assert.deepEqual(killed, [1]);
  let t = 0;
  await assert.rejects(
    startServer(
      {
        gguf: GGUF(),
        exe: process.execPath,
        port: 1,
        readyTimeoutMs: 10,
        ollamaUrl: "http://127.0.0.1:1",
      },
      roots,
      {
        spawn: () => fakeChild(2),
        kill: (p) => killed.push(p),
        wait: async () => {},
        now: () => (t += 100),
        preflight: { readGpu: gpu(20) },
        install: false,
      },
    ),
    /no \/health 200/,
  );
  assert.deepEqual(killed, [1, 2]);
  await assert.rejects(
    startServer(
      {
        gguf: GGUF(),
        exe: process.execPath,
        port: 1,
        ollamaUrl: "http://127.0.0.1:1",
      },
      roots,
      {
        spawn: () => assert.fail("must not spawn"),
        preflight: { readGpu: gpu(0.1) },
        install: false,
      },
    ),
    /refusing to start/,
  );
});

// --- the cache suite ---------------------------------------------------------

test("cache sequences: three ids, nonce first, tool order and volatile position differ", () => {
  const suite = loadSuite("cache");
  const seqs = expandCache(suite, { nonce: "abc" });
  assert.deepEqual(
    [...new Set(seqs.map((s) => s.id))],
    ["same-prefix", "volatile-first-vs-last", "tool-reorder"],
  );
  assert.equal(
    seqs.reduce((n, s) => n + s.steps.length, 0),
    14,
  );
  assert.ok(
    seqs.every((s) =>
      s.steps.every((x) => x.messages[0].content.startsWith("[cache-lab abc ")),
    ),
  );
  const tr = seqs.find((s) => s.id === "tool-reorder");
  assert.notDeepEqual(
    tr.steps[2].tools.map((t) => t.name),
    tr.steps[1].tools.map((t) => t.name),
  );
  assert.deepEqual(tr.steps[3].tools, tr.steps[1].tools);
  const first = seqs.find((s) => s.arm === "volatile-first").steps;
  const last = seqs.find((s) => s.arm === "volatile-last").steps;
  assert.match(
    first[1].messages[0].content,
    /Current time: .*\n[^]*You are a careful/,
  );
  assert.match(last[1].messages[0].content, /careful[^]*\nCurrent time:/);
});

test("cache run against a fake llama-server shows what the counters should show", async () => {
  const fake = await startFakeLlama();
  const roots = fresh();
  const logs = [];
  try {
    const client = new Engine({ api: "openai-chat", baseUrl: fake.url });
    const s = await runCache({
      client,
      suite: loadSuite("cache"),
      models: [
        { name: "m", size: 1e9, capabilities: ["tools"], family: "gguf" },
      ],
      roots,
      budget: new Budget({ maxRequests: 50 }),
      log: (l) => logs.push(l),
      facts: {},
      limits: { maxVramGB: 8, maxRamGB: 16 },
      cfg: { api: "openai-chat" },
    });
    assert.equal(s.ran, 14);
    const recs = fs
      .readFileSync(s.file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const get = (seq, arm, step) =>
      recs.find((r) => r.seq === seq && r.arm === arm && r.step === step).usage;
    assert.equal(get("same-prefix", "default", 0).cachedTokens, 0);
    assert.ok(get("same-prefix", "default", 1).promptEvalTokens <= 1);
    assert.ok(
      get("same-prefix", "default", 3).cachedTokens >
        get("same-prefix", "default", 3).promptEvalTokens,
    );
    assert.ok(
      get("volatile-first-vs-last", "volatile-last", 1).cachedTokens >
        get("volatile-first-vs-last", "volatile-first", 1).cachedTokens,
    );
    assert.ok(
      get("tool-reorder", "default", 2).cachedTokens <
        get("tool-reorder", "default", 1).cachedTokens,
    );
    assert.ok(
      recs.every(
        (r) => r.engine?.build === "b12206-fake" && r.api === "openai-chat",
      ),
    );
    const md = buildCacheReport(recs);
    assert.match(md, /## same-prefix: m via openai-chat/);
    assert.match(md, /evaluated vs cold/);
    assert.ok(logs.some((l) => /new-last-user-message/.test(l)));
  } finally {
    await fake.close();
  }
});

test("cache run on Ollama records prompt_eval_count and durations; a loaded other model refuses", async () => {
  const fake = await startFake();
  const roots = fresh();
  try {
    const client = new Engine({ api: "ollama-chat", baseUrl: fake.url });
    const s = await runCache({
      client,
      suite: loadSuite("cache"),
      models: [
        {
          name: "fake-small:1b",
          size: 2e9,
          capabilities: ["tools"],
          family: "fake",
        },
      ],
      roots,
      budget: new Budget({ maxRequests: 50 }),
      facts: {},
      limits: { maxVramGB: 8, maxRamGB: 16 },
      cfg: { api: "ollama-chat" },
    });
    assert.equal(s.ran, 14);
    const r = JSON.parse(fs.readFileSync(s.file, "utf8").split("\n")[0]);
    assert.equal(r.usage.promptTokens, 40);
    assert.equal(r.usage.promptEvalMs, undefined);
    assert.deepEqual(fake.state.unloads, ["fake-small:1b"]);
  } finally {
    await fake.close();
  }
  const busy = await startFake({ loaded: ["other:7b"] });
  try {
    const s = await runCache({
      client: new Engine({ api: "ollama-chat", baseUrl: busy.url }),
      suite: loadSuite("cache"),
      models: [
        { name: "fake-small:1b", size: 2e9, capabilities: [], family: "fake" },
      ],
      roots: fresh(),
      facts: {},
      limits: { maxVramGB: 8, maxRamGB: 16 },
      cfg: { api: "ollama-chat" },
    });
    assert.equal(s.refused.length, 1);
    assert.equal(busy.state.chats.length, 0);
  } finally {
    await busy.close();
  }
});

test("cli: run the leaks suite and the cache suite over openai-chat with --out as the results folder", async () => {
  const { main } = await import("../lab.mjs");
  const fake = await startFakeLlama();
  const dir = tmp();
  const gguf = path.join(dir, "tiny.gguf");
  fs.writeFileSync(gguf, Buffer.alloc(1000));
  const common = [
    "--api",
    "openai-chat",
    "--base-url",
    fake.url,
    "--gguf",
    gguf,
    "--ollama-url",
    "http://127.0.0.1:1",
    "--out",
    path.join(dir, "out"),
    "--cooldown",
    "0",
    "--think",
    "default",
    "--num-predict",
    "64",
    "--tool-choice",
    "auto",
    "--seed",
    "1",
  ];
  try {
    await main([
      "run",
      "--run",
      "--suite",
      "dialect-probe",
      "--styles",
      "codeblock",
      "--modes",
      "native",
      "--max-requests",
      "3",
      ...common,
    ]);
    const f = path.join(dir, "out", "dialect-probe.jsonl");
    const recs = fs
      .readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(recs.length, 3);
    assert.match(
      recs[0].key,
      /@openai-chat,think=default,np=64,tc=auto,seed=1\|?/,
    );
    assert.equal(recs[0].api, "openai-chat");
    assert.equal(recs[0].cfg.numPredict, 64);
    assert.equal(recs[0].engine.build, "b12206-fake");
    const body = fake.state.requests[0];
    assert.equal(body.max_tokens, 64);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.seed, 1);
    assert.equal(body.chat_template_kwargs, undefined);
    await main([
      "run",
      "--run",
      "--suite",
      "cache",
      "--max-requests",
      "20",
      ...common,
    ]);
    const cache = fs
      .readFileSync(path.join(dir, "out", "cache.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(cache.length, 14);
  } finally {
    await fake.close();
  }
});
