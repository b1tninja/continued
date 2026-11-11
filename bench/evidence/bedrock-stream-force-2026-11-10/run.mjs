import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("D:/code/continued/core/package.json");
const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const { fromIni } = require("@aws-sdk/credential-providers");
const DIR = "D:/temp/claude/67392035d714e8ba/b98023ea-3bcc-4ecb-9e49-e3cf2888146a/scratchpad/bedrock-stream-force";
const OUT = DIR + "/records.jsonl";
const RUN = "bsf-2026-11-10";
const CAP = 0.45; // upper-bound USD guard at $1/M in, $5/M out
const models = JSON.parse(process.argv[2]); // [[id, region]]
const cells = (process.argv[3] || "stream,auto,any_hello,any_tool,named").split(",");
const N = Number(process.argv[4] || 8);
const done = new Map();
let spentIn = 0, spentOut = 0;
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); const k = r.model + "|" + r.cell; done.set(k, (done.get(k) || 0) + 1); spentIn += r.usage?.in || 0; spentOut += r.usage?.out || 0; }
const cost = () => spentIn * 1e-6 + spentOut * 5e-6;
const tool = { toolSpec: { name: "read_file", description: "Read a file", inputSchema: { json: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } } };
const P_HELLO = "Say hello.", P_TOOL = "Read the file src/main.ts using the tool.";
const choice0 = { stream: { auto: {} }, auto: { auto: {} }, any_hello: { any: {} }, any_tool: { any: {} }, named: { tool: { name: "read_file" } } };
const prompt0 = { stream: P_TOOL, auto: P_TOOL, any_hello: P_HELLO, any_tool: P_TOOL, named: P_HELLO };
const choice = new Proxy(choice0, { get: (t, k) => t[String(k).split("@")[0]] });
const prompt = new Proxy(prompt0, { get: (t, k) => t[String(k).split("@")[0]] });
const clients = {};
const cl = (r) => (clients[r] ??= new BedrockRuntimeClient({ region: r, credentials: fromIni({ profile: "torgate" }), maxAttempts: 2, requestHandler: new NodeHttpHandler({ requestTimeout: 45000, connectionTimeout: 10000 }) }));
async function one(id, region, cellFull) {
  const [cell, mt] = cellFull.split("@"); const MT = Number(mt || 200);
  const req = { modelId: id, messages: [{ role: "user", content: [{ text: prompt[cell] }] }], inferenceConfig: id.includes("kimi-k3") ? { maxTokens: MT } : { maxTokens: MT, temperature: 0 }, toolConfig: { tools: [tool], toolChoice: choice[cell] } };
  const rec = { run: RUN, model: id, region, cell: cellFull, request: { prompt: prompt[cell], toolChoice: choice[cell], maxTokens: MT, tools: 1, api: cell === "stream" ? "ConverseStream" : "Converse" }, ts: new Date().toISOString() };
  try {
    if (cell === "stream") {
      const resp = await cl(region).send(new ConverseStreamCommand(req));
      const tu = {}; let text = "", stop, usage, order = [];
      for await (const ev of resp.stream) {
        if (ev.contentBlockStart?.start?.toolUse) { const i = ev.contentBlockStart.contentBlockIndex; tu[i] = { name: ev.contentBlockStart.start.toolUse.name, frags: [], start: true }; order.push(i); }
        if (ev.contentBlockDelta) { const i = ev.contentBlockDelta.contentBlockIndex; const d = ev.contentBlockDelta.delta; if (d.text) text += d.text; if (d.toolUse) { tu[i] ??= { name: null, frags: [], start: false }; tu[i].frags.push(d.toolUse.input); } }
        if (ev.messageStop) stop = ev.messageStop.stopReason;
        if (ev.metadata) usage = ev.metadata.usage;
      }
      const calls = Object.values(tu).map((t) => { const j = t.frags.join(""); let ok = false, v; try { v = JSON.parse(j); ok = true; } catch {} return { name: t.name, hasStart: t.start, nfrags: t.frags.length, joined: j.slice(0, 120), parseOk: ok, hasPath: ok && typeof v?.path === "string" }; });
      rec.response = { outcome: calls.length ? (calls.every((c) => c.parseOk && c.hasStart) ? "tool_ok" : "tool_broken") : "text", stopReason: stop, calls, text: text.slice(0, 120) };
      rec.usage = { in: usage?.inputTokens || 0, out: usage?.outputTokens || 0 };
    } else {
      const resp = await cl(region).send(new ConverseCommand(req));
      const blocks = resp.output?.message?.content || [];
      const calls = blocks.filter((b) => b.toolUse).map((b) => ({ name: b.toolUse.name, input: JSON.stringify(b.toolUse.input).slice(0, 120) }));
      const text = blocks.filter((b) => b.text).map((b) => b.text).join("").slice(0, 120);
      rec.response = { outcome: calls.length ? "tool" : "text", http: 200, stopReason: resp.stopReason, calls, text, namedMatch: cell === "named" ? calls.some((c) => c.name === "read_file") : undefined };
      rec.usage = { in: resp.usage?.inputTokens || 0, out: resp.usage?.outputTokens || 0 };
    }
  } catch (e) { rec.response = { outcome: "error" }; rec.error = { name: e.name, http: e.$metadata?.httpStatusCode, message: String(e.message).slice(0, 300) }; rec.usage = { in: 0, out: 0 }; }
  spentIn += rec.usage.in; spentOut += rec.usage.out;
  fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
  return rec;
}
for (const [id, region] of models) {
  for (const cell of cells) {
    const key = id + "|" + cell; let have = done.get(key) || 0; const errs = [];
    while (have < N) {
      if (cost() > CAP) { console.log("BUDGET GUARD hit", cost().toFixed(4)); process.exit(0); }
      const batch = Math.min(4, N - have);
      const rs = await Promise.all(Array.from({ length: batch }, () => one(id, region, cell)));
      have += batch; for (const r of rs) if (r.error) errs.push(r.error.message);
      if (errs.length >= 3 && errs.length === have && new Set(errs.map((m) => m.slice(0, 60))).size === 1) { break; } // deterministic refusal
    }
    console.log(id, cell, "done", have, "spent<=$" + cost().toFixed(4));
  }
}
