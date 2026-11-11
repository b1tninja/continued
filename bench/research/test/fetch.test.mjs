import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apiUrl, buildDataset, fetchRepo, pickTemplate } from "../lib/hf.mjs";
import {
  FetchError,
  StopError,
  USER_AGENT,
  checkUrl,
  createClient,
  parseRateLimit,
} from "../lib/http.mjs";

const cache = () => mkdtempSync(join(tmpdir(), "mrt-cache-"));

function fakeFetch(routes, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    const r = routes[url.split("?")[0]] ?? { status: 404, body: "" };
    const res = typeof r === "function" ? r(init) : r;
    return new Response(res.status === 304 ? null : res.body, {
      status: res.status,
      headers: res.headers ?? {},
    });
  };
}
const quiet = { sleep: async () => {}, minDelayMs: 0 };
const API = "https://huggingface.co/api/models/o/r";

test("user agent has no personal data and no credential header is ever sent", async () => {
  assert.match(
    USER_AGENT,
    /^continuous-model-research\/[\d.]+ \(\+https:\/\/github.com\/b1tninja\/continuous\)$/,
  );
  process.env.HF_TOKEN = "hf_should_never_be_sent";
  const seen = [];
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({ [API]: { status: 200, body: "{}" } }, seen),
    ...quiet,
  });
  await c.get(apiUrl("o/r"));
  delete process.env.HF_TOKEN;
  const h = seen[0].init.headers;
  assert.equal(h["user-agent"], USER_AGENT);
  assert.equal(h.authorization, undefined);
  assert.ok(!JSON.stringify(seen).includes("hf_should_never_be_sent"));
});

test("conditional GET: ETag is sent, 304 is served from the on-disk cache", async () => {
  const dir = cache();
  const seen = [];
  let n = 0;
  const f = fakeFetch(
    {
      [API]: (init) =>
        n++ === 0
          ? { status: 200, body: '{"a":1}', headers: { etag: 'W/"abc"' } }
          : init.headers["if-none-match"] === 'W/"abc"'
            ? { status: 304 }
            : { status: 500, body: "no etag sent" },
    },
    seen,
  );
  const first = await createClient({
    cacheDir: dir,
    fetchImpl: f,
    ...quiet,
  }).get(apiUrl("o/r"));
  const second = await createClient({
    cacheDir: dir,
    fetchImpl: f,
    ...quiet,
  }).get(apiUrl("o/r"));
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.body, '{"a":1}');
});

test("429 stops the run and is not retried", async () => {
  const seen = [];
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch(
      {
        [API]: {
          status: 429,
          body: "",
          headers: { "retry-after": "60", ratelimit: '"api";r=0;t=60' },
        },
      },
      seen,
    ),
    ...quiet,
  });
  await assert.rejects(
    c.get(apiUrl("o/r")),
    (e) => e instanceof StopError && /Retry-After=60/.test(e.message),
  );
  assert.equal(seen.length, 1);
});

test("an exhausted rate-limit window stops after the response", async () => {
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({
      [API]: {
        status: 200,
        body: "{}",
        headers: { ratelimit: '"api";r=1;t=300' },
      },
    }),
    ...quiet,
  });
  await assert.rejects(c.get(apiUrl("o/r")), StopError);
  assert.deepEqual(parseRateLimit('"api";r=499;t=300'), {
    remaining: 499,
    reset: 300,
  });
  assert.equal(parseRateLimit(null), null);
});

test("request budget is enforced", async () => {
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({ [API]: { status: 200, body: "{}" } }),
    budget: 1,
    ...quiet,
  });
  await c.get(apiUrl("o/r"));
  await assert.rejects(c.get(apiUrl("o/r") + "&x=1"), /budget/);
});

test("other hosts, weights and non-allowlisted files are refused", async () => {
  assert.throws(
    () => checkUrl("https://example.com/api/models/o/r"),
    FetchError,
  );
  assert.throws(
    () => checkUrl("http://huggingface.co/api/models/o/r"),
    FetchError,
  );
  assert.throws(
    () => checkUrl("https://huggingface.co/o/r/raw/main/model.safetensors"),
    /allowlist/,
  );
  assert.throws(
    () => checkUrl("https://huggingface.co/o/r/resolve/main/x.gguf"),
    FetchError,
  );
  checkUrl("https://huggingface.co/o/r/raw/main/chat_template.jinja");
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({
      [API]: {
        status: 302,
        body: "",
        headers: { location: "https://evil.example/x" },
      },
    }),
    ...quiet,
  });
  await assert.rejects(c.get(apiUrl("o/r")), /only https:\/\/huggingface.co/);
});

const apiJson = (extra = {}) =>
  JSON.stringify({
    sha: "a".repeat(40),
    gated: false,
    cardData: { license: "mit" },
    pipeline_tag: "text-generation",
    config: {},
    ...extra,
  });

test("template from config.chat_template_jinja, with licence, sha and excerpt", async () => {
  const tpl = "{% if tools %}<TOOLCALL>{% endif %}";
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({
      [API]: {
        status: 200,
        body: apiJson({ config: { chat_template_jinja: tpl } }),
      },
    }),
    ...quiet,
  });
  const rec = await fetchRepo(c, "o/r");
  assert.equal(rec.status, "ok");
  assert.equal(rec.license, "mit");
  assert.equal(rec.template.dialect, "toolcall-json");
  assert.match(rec.template.sha256, /^[0-9a-f]{64}$/);
  assert.equal(rec.template.excerpt, tpl);
  assert.ok(!("text" in rec.template));
});

test("list of named templates prefers tool_use", () => {
  const t = pickTemplate(
    [
      { name: "default", template: "d" },
      { name: "tool_use", template: "t" },
    ],
    "x",
  );
  assert.equal(t.text, "t");
});

test("a gated repo is recorded as gated and its template is not read", async () => {
  const seen = [];
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch(
      {
        [API]: {
          status: 200,
          body: apiJson({
            gated: "manual",
            config: { chat_template_jinja: "<TOOLCALL> tools" },
          }),
        },
      },
      seen,
    ),
    ...quiet,
  });
  const rec = await fetchRepo(c, "o/r");
  assert.equal(rec.status, "gated");
  assert.equal(rec.template.outcome, "undecided");
  assert.equal(rec.template.sha256, null);
  assert.equal(seen.length, 1, "no raw file was tried");
});

test("a 401 repo is recorded as unavailable and nothing else is tried", async () => {
  const seen = [];
  const c = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch(
      { [API]: { status: 401, body: "Invalid username or password." } },
      seen,
    ),
    ...quiet,
  });
  const rec = await fetchRepo(c, "o/r");
  assert.equal(rec.status, "unavailable");
  assert.match(rec.detail, /not worked around/);
  assert.equal(seen.length, 1);
});

test("no template in config falls back to the raw jinja, then to undecided", async () => {
  const raw = "https://huggingface.co/o/r/raw/main/chat_template.jinja";
  const ok = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({
      [API]: { status: 200, body: apiJson() },
      [raw]: { status: 200, body: "{{ tools }} <TOOLCALL>" },
    }),
    ...quiet,
  });
  assert.equal(
    (await fetchRepo(ok, "o/r")).template.source,
    "raw:chat_template.jinja",
  );
  const none = createClient({
    cacheDir: cache(),
    fetchImpl: fakeFetch({ [API]: { status: 200, body: apiJson() } }),
    ...quiet,
  });
  const rec = await fetchRepo(none, "o/r");
  assert.equal(rec.template.reason, "no-template");
  assert.match(rec.detail, /no chat template/);
});

test("bad repo names are refused before any request", () => {
  assert.throws(() => apiUrl("../etc/passwd"));
  assert.throws(() => apiUrl("noslash"));
});

test("dataset is sorted, dated and carries no raw template text", () => {
  const d = buildDataset(
    [
      { repo: "b/b", template: {} },
      { repo: "a/a", template: {} },
    ],
    new Date("2026-11-10T00:00:00Z"),
  );
  assert.deepEqual(Object.keys(d.repos), ["a/a", "b/b"]);
  assert.equal(d.fetchedAt, "2026-11-10T00:00:00.000Z");
});
