// A small Ollama client: /api/tags, /api/show, /api/ps and /api/chat, nothing
// else. Loopback only unless the caller says otherwise. Every request has a
// timeout and honours an abort signal; the client never retries.

export class LabError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // timeout | aborted | http | network | refused
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Throws unless the base URL is a loopback address (or allowRemote). */
export function assertLoopback(baseUrl, allowRemote = false) {
  const u = new URL(baseUrl);
  if (!allowRemote && !LOOPBACK.has(u.hostname))
    throw new LabError(
      "refused",
      `refusing non-loopback base URL ${u.hostname}; pass --allow-remote to override`,
    );
  return u.origin;
}

export const toOllamaTools = (tools) =>
  tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));

export class OllamaClient {
  constructor({
    baseUrl = "http://127.0.0.1:11434",
    allowRemote = false,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 120_000,
    signal,
  } = {}) {
    this.origin = assertLoopback(baseUrl, allowRemote);
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.signal = signal;
    this.requests = 0;
  }

  async call(
    pathname,
    body,
    { timeoutMs, method = "POST", ignoreSignal = false } = {},
  ) {
    const signal = ignoreSignal ? undefined : this.signal;
    const ms = timeoutMs ?? this.requestTimeoutMs;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) ctl.abort();
    try {
      this.requests++;
      const res = await this.fetch(this.origin + pathname, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LabError("http", `HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      // The timer keeps running while the body is read: it is a whole-request
      // timeout, and `done` stops it.
      return { res, done: () => clearTimeout(timer), timedOut: () => timedOut };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof LabError) throw e;
      if (timedOut) throw new LabError("timeout", `no reply within ${ms} ms`);
      if (signal?.aborted) throw new LabError("aborted", "aborted");
      throw new LabError("network", String(e?.message ?? e));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async json(pathname, body, opts) {
    const { res, done, timedOut } = await this.call(pathname, body, opts);
    try {
      return await res.json();
    } catch (e) {
      throw new LabError(
        timedOut() ? "timeout" : this.signal?.aborted ? "aborted" : "network",
        String(e?.message ?? e),
      );
    } finally {
      done();
    }
  }

  tags() {
    return this.json("/api/tags", undefined, {
      method: "GET",
      timeoutMs: 15_000,
    });
  }
  ps() {
    return this.json("/api/ps", undefined, {
      method: "GET",
      timeoutMs: 15_000,
    });
  }
  show(model) {
    return this.json("/api/show", { model }, { timeoutMs: 30_000 });
  }

  /** Free the model's memory now. Never throws: a failed unload is reported. */
  async unload(model) {
    try {
      await this.json(
        "/api/chat",
        { model, messages: [], keep_alive: 0 },
        { timeoutMs: 30_000, ignoreSignal: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One chat request. Returns the reply as the lab keeps it:
   * { text, thinking, toolCalls: [{name, arguments: "<json>"}], doneReason,
   *   usage: {promptTokens, outputTokens, evalMs, loadMs, totalMs, wallMs},
   *   chunks? }.
   */
  async chat({
    model,
    messages,
    tools,
    stream = false,
    options = {},
    think,
    keepAlive,
    timeoutMs,
  }) {
    const body = { model, messages, stream, options };
    if (tools?.length) body.tools = toOllamaTools(tools);
    if (think !== undefined) body.think = think;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    const t0 = Date.now();
    const { res, done, timedOut } = await this.call("/api/chat", body, {
      timeoutMs,
    });
    const out = {
      text: "",
      thinking: "",
      toolCalls: [],
      doneReason: undefined,
      usage: {},
    };
    const take = (obj) => {
      if (obj.error) throw new LabError("http", String(obj.error));
      const m = obj.message ?? {};
      out.text += m.content ?? "";
      out.thinking += m.thinking ?? "";
      for (const c of m.tool_calls ?? []) {
        const args = c.function?.arguments;
        out.toolCalls.push({
          name: c.function?.name ?? "",
          arguments:
            typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
      }
      if (obj.done) {
        out.doneReason = obj.done_reason;
        out.usage = {
          promptTokens: obj.prompt_eval_count,
          outputTokens: obj.eval_count,
          evalMs:
            obj.eval_duration != null ? obj.eval_duration / 1e6 : undefined,
          loadMs:
            obj.load_duration != null ? obj.load_duration / 1e6 : undefined,
          totalMs:
            obj.total_duration != null ? obj.total_duration / 1e6 : undefined,
        };
      }
    };
    try {
      if (!stream) {
        take(await res.json());
      } else {
        out.chunks = [];
        const dec = new TextDecoder();
        let buf = "";
        for await (const part of res.body) {
          buf += dec.decode(part, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            const obj = JSON.parse(line);
            if (obj.message?.content) out.chunks.push(obj.message.content);
            take(obj);
          }
        }
        if (buf.trim()) take(JSON.parse(buf));
      }
    } catch (e) {
      if (e instanceof LabError) throw e;
      if (timedOut())
        throw new LabError(
          "timeout",
          `no reply within ${timeoutMs ?? this.requestTimeoutMs} ms`,
        );
      if (this.signal?.aborted) throw new LabError("aborted", "aborted");
      throw new LabError(
        "network",
        `reply cut off: ${String(e?.message ?? e)}`,
      );
    } finally {
      done();
    }
    out.usage.wallMs = Date.now() - t0;
    return out;
  }
}
