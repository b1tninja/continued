// A fake llama-server on a loopback port, plus the OpenAI-style responder the
// fake Ollama reuses for /v1. It emulates a prefix cache by string prefix so
// the cache suite has something to measure: tokens are characters / 4.
import http from "node:http";

const tokens = (s) => Math.ceil(s.length / 4);
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

export const promptOf = (body) =>
  JSON.stringify(body.tools ?? []) +
  (body.messages ?? []).map((m) => `${m.role}:${m.content}`).join("\n");

export function defaultReply(body) {
  const user =
    [...(body.messages ?? [])].reverse().find((m) => m.role === "user")
      ?.content ?? "";
  const m = /Read the file ([\w./-]+?)[.\s]/.exec(user + " ");
  if (body.tools?.length && m)
    return { tool_calls: [{ name: "read_file", arguments: { path: m[1] } }] };
  return { content: "Paris" };
}

/** Write an OpenAI-style reply (whole or SSE). `engine` is "llama" or "ollama". */
export function openaiRespond(res, body, s, { engine, state, reasoningField }) {
  const prompt = promptOf(body);
  const cached =
    engine === "llama" ? commonPrefix(state.last ?? "", prompt) : 0;
  state.last = prompt;
  const cacheN = Math.min(tokens(prompt), Math.floor(cached / 4));
  const promptN = tokens(prompt) - cacheN;
  const text = s.content ?? "";
  const calls = (s.tool_calls ?? []).map((c, i) => ({
    index: i,
    id: `call_${i}`,
    type: "function",
    function: {
      name: c.name,
      arguments:
        typeof c.arguments === "string"
          ? c.arguments
          : JSON.stringify(c.arguments),
    },
  }));
  const usage = {
    prompt_tokens: tokens(prompt),
    completion_tokens: 7,
    total_tokens: tokens(prompt) + 7,
  };
  const timings =
    engine === "llama"
      ? {
          cache_n: cacheN,
          prompt_n: promptN,
          prompt_ms: promptN * 2,
          predicted_n: 7,
          predicted_ms: 70,
          predicted_per_second: 100,
          prompt_per_second: 500,
        }
      : undefined;
  const finish = calls.length ? "tool_calls" : (s.finish ?? "stop");
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: finish,
            message: {
              role: "assistant",
              content: text,
              ...(s.reasoning ? { [reasoningField]: s.reasoning } : {}),
              ...(calls.length ? { tool_calls: calls } : {}),
            },
          },
        ],
        usage,
        ...(timings ? { timings } : {}),
      }),
    );
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const chunk = (delta, fr = null) =>
    send({ choices: [{ index: 0, delta, finish_reason: fr }] });
  if (s.reasoning) chunk({ [reasoningField]: s.reasoning });
  if (text) {
    chunk({ content: text.slice(0, 2) });
    chunk({ content: text.slice(2) });
  }
  for (const c of calls) {
    const a = c.function.arguments;
    chunk({
      tool_calls: [
        {
          index: c.index,
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: "" },
        },
      ],
    });
    chunk({
      tool_calls: [{ index: c.index, function: { arguments: a.slice(0, 5) } }],
    });
    chunk({
      tool_calls: [{ index: c.index, function: { arguments: a.slice(5) } }],
    });
  }
  chunk({}, finish);
  if (body.stream_options?.include_usage || timings)
    send({ choices: [], usage, ...(timings ? { timings } : {}) });
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startFakeLlama({
  script = defaultReply,
  reasoningField = "reasoning_content",
  readyAfter = 0,
  props = {},
} = {}) {
  const state = { requests: [], hits: [], last: "", health: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    state.hits.push(req.url);
    const json = (o, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.url === "/health")
      return ++state.health > readyAfter
        ? json({ status: "ok" })
        : json({ error: { code: 503, message: "Loading model" } }, 503);
    if (req.url === "/props")
      return json({
        build_info: "b12206-fake",
        total_slots: 1,
        model_path: "fake.gguf",
        chat_template: "{{ fake }}",
        default_generation_settings: { n_ctx: 16384 },
        ...props,
      });
    if (req.url === "/v1/chat/completions") {
      state.requests.push(body);
      const s = await script(body, state);
      if (s.status)
        return json({ error: { message: s.error ?? "boom" } }, s.status);
      return openaiRespond(res, body, s, {
        engine: "llama",
        state,
        reasoningField,
      });
    }
    if (req.url === "/apply-template") {
      state.requests.push({ applyTemplate: body });
      return json({
        prompt:
          body.messages.map((m) => `<${m.role}>${m.content}`).join("") +
          "<assistant>",
      });
    }
    if (req.url === "/completion") {
      state.requests.push({ completion: body });
      const cacheN = Math.floor(commonPrefix(state.last, body.prompt) / 4);
      state.last = body.prompt;
      return json({
        content: "Paris",
        stop_type: "eos",
        tokens_cached: cacheN,
        tokens_evaluated: tokens(body.prompt),
        timings: {
          cache_n: cacheN,
          prompt_n: tokens(body.prompt) - cacheN,
          prompt_ms: 3,
          predicted_n: 2,
          predicted_ms: 8,
        },
      });
    }
    json({ error: "no such endpoint" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}
