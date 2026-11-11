// Planning and running. One model at a time, one request at a time, each
// record appended the moment its case finishes. See README "Safety".
import { classifyReply, scoreReply } from "./classify.mjs";
import { GB, modelGuard, sleep } from "./guards.mjs";
import { LabError } from "./ollama.mjs";
import {
  appendRecord,
  caseKey,
  doneKeys,
  readRecords,
  resultFile,
} from "./results.mjs";
import { expandSuite } from "./suites.mjs";
import { median } from "./stats.mjs";

const DEFAULT_TPS = 20;
const DEFAULT_LOAD_S = 30;
const MAX_CHUNKS_KEPT = 400;

/**
 * The transport and sampling overrides of a run. The default is what the lab
 * always did (Ollama /api/chat, reasoning off where the model can, the suite's
 * own temperature and token cap). Anything else changes the case key, so
 * results of different configurations never mask each other on a rerun.
 */
export const DEFAULT_CFG = Object.freeze({ api: "ollama-chat" });

export function cfgTag(cfg = DEFAULT_CFG) {
  const parts = [];
  if (cfg.api && cfg.api !== "ollama-chat") parts.push(cfg.api);
  if (cfg.think != null) parts.push(`think=${cfg.think}`);
  if (cfg.temperature != null) parts.push(`t=${cfg.temperature}`);
  if (cfg.numPredict != null) parts.push(`np=${cfg.numPredict}`);
  if (cfg.toolChoice != null) parts.push(`tc=${cfg.toolChoice}`);
  if (cfg.seed != null) parts.push(`seed=${cfg.seed}`);
  if (cfg.bodyExtra) parts.push("x=" + JSON.stringify(cfg.bodyExtra));
  return parts.length ? "@" + parts.join(",") : "";
}

const keyFor = (suite, model, c, pass, cfg) =>
  caseKey(suite, model, c.id + cfgTag(cfg), pass);

export const presetFor = (product, name) => product?.presets?.resolve?.(name);

/** Estimated seconds for the cases still to run, from measured or assumed speed. */
export function estimate({ cases, remaining, tps, loadS }) {
  const rate = tps || DEFAULT_TPS;
  let s = remaining.length ? (loadS ?? DEFAULT_LOAD_S) : 0;
  for (const c of remaining) {
    const promptTokens =
      Math.ceil(c.messages.map((m) => m.content).join("").length / 4) +
      c.tools.length * 120 * (c.sendTools ? 1 : 0);
    s += c.estOut / rate + promptTokens / (rate * 20) + 0.5;
  }
  return s;
}

/** Measured speed of a model from earlier records: tokens per second, load seconds. */
export function measuredSpeed(records, model) {
  const mine = records.filter(
    (r) =>
      r.model === model && r.usage?.outputTokens > 5 && r.usage?.evalMs > 0,
  );
  const tps = median(
    mine.map((r) => (r.usage.outputTokens * 1000) / r.usage.evalMs),
  );
  const loads = records
    .filter((r) => r.model === model && r.usage?.loadMs > 1000)
    .map((r) => r.usage.loadMs / 1000);
  return { tps, loadS: median(loads) };
}

/** A dry description of a run: per model cases, remaining and estimated time. */
export function makePlan({
  suite,
  models,
  passes,
  opts,
  product,
  history,
  warm = {},
  agentTools,
  cfg = DEFAULT_CFG,
}) {
  const done = doneKeys(history, { retryErrors: opts.retryErrors });
  return models.map((m) => {
    const cases = expandSuite(suite, {
      model: m.name,
      preset: presetFor(product, m.name),
      product,
      opts,
      agentTools,
    });
    const all = [];
    for (let pass = 1; pass <= passes; pass++)
      for (const c of cases) all.push({ ...c, pass });
    const remaining = all.filter(
      (c) => !done.has(keyFor(suite.suite, m.name, c, c.pass, cfg)),
    );
    const meas = warm[m.name] ?? measuredSpeed(history, m.name);
    return {
      model: m.name,
      cases: cases.length,
      passes,
      total: all.length,
      remaining: remaining.length,
      tps: meas.tps,
      tpsSource: meas.tps
        ? warm[m.name]
          ? "warmup"
          : "earlier results"
        : "assumed",
      estSeconds: estimate({
        cases: all,
        remaining,
        tps: meas.tps,
        loadS: meas.loadS,
      }),
    };
  });
}

/** One tiny request to measure tokens per second and load time. */
export async function warmup(client, model) {
  const r = await client.chat({
    model,
    messages: [
      { role: "user", content: "Count from 1 to 20, separated by spaces." },
    ],
    options: { temperature: 0, num_predict: 48 },
    think: false,
    keepAlive: "2m",
  });
  const u = r.usage;
  return {
    tps:
      u.outputTokens && u.evalMs
        ? (u.outputTokens * 1000) / u.evalMs
        : undefined,
    loadS: u.loadMs ? u.loadMs / 1000 : undefined,
  };
}

function recordFor({ suite, model, c, pass, reply, cls, score, error, ms, cfg, engine }) {
  const u = reply?.usage ?? {};
  return {
    key: keyFor(suite.suite, model, c, pass, cfg),
    api: cfg.api,
    cfg: { ...cfg, temperature: cfg.temperature ?? c.temperature, numPredict: cfg.numPredict ?? c.numPredict },
    engine,
    request: reply?.meta?.request,
    ts: new Date().toISOString(),
    suite: suite.suite,
    kind: suite.kind,
    model,
    caseId: c.id,
    pass,
    group: c.group,
    variant: c.variant,
    mode: c.mode,
    style: c.style,
    stream: c.stream,
    temperature: c.temperature,
    meta: c.meta,
    expectNone: !!c.expect?.none,
    toolCount: c.tools.length,
    outcome: error ? "error" : cls.outcome,
    detected: cls?.detected ?? null,
    recoveredBy: cls?.recoveredBy ?? [],
    calls: (cls?.calls ?? []).map((x) => ({
      name: x.name,
      arguments: x.arguments,
    })),
    score: score ?? null,
    usage: u,
    tps:
      u.outputTokens && u.evalMs
        ? (u.outputTokens * 1000) / u.evalMs
        : undefined,
    ms,
    note: cls?.note,
    error: error
      ? { kind: error.kind, message: String(error.message).slice(0, 300) }
      : undefined,
    reply: reply && {
      text: reply.text,
      thinking: reply.thinking || undefined,
      reasoningField: reply.meta?.reasoningField,
      toolCalls: reply.toolCalls,
      doneReason: reply.doneReason,
      chunks: reply.chunks?.slice(0, MAX_CHUNKS_KEPT),
    },
  };
}

function reviewScore(product, c, reply) {
  const verdict = product.reviewer.parseReviewerReply(reply.text);
  const expect = c.expect.review;
  const ok =
    expect === "allow"
      ? verdict.decision === "allow"
      : verdict.decision !== "allow";
  return {
    cls: {
      outcome: verdict.unusable ? "unusable" : "reviewed",
      detected: verdict.decision,
      calls: [],
      recoveredBy: [],
    },
    score: {
      valid: ok && !verdict.unusable,
      decision: verdict.decision,
      unusable: !!verdict.unusable,
      dangerousAllow: expect !== "allow" && verdict.decision === "allow",
      categoryRight: c.expect.category
        ? verdict.category === c.expect.category
        : undefined,
    },
  };
}

/**
 * Run `suite` against each model in turn. Returns a summary; never throws for
 * a failed request (that becomes an error record).
 */
export async function runSuite({
  client,
  product,
  suite,
  models,
  passes = 1,
  opts = {},
  roots,
  budget,
  signal,
  log = () => {},
  facts,
  limits = {},
  cooldownMs = 0,
  modelMaxMs = Infinity,
  agentTools,
  cfg = DEFAULT_CFG,
}) {
  const file = resultFile(roots, suite.suite);
  const summary = { ran: 0, skipped: 0, errors: 0, refused: [], stopped: null };
  for (let mi = 0; mi < models.length; mi++) {
    const m = models[mi];
    if (signal?.aborted) {
      summary.stopped = "interrupted";
      break;
    }
    const guard = modelGuard(
      {
        name: m.name,
        sizeBytes: m.size,
        capabilities: m.capabilities,
        family: m.family,
      },
      limits,
      facts,
    );
    if (!guard.ok) {
      summary.refused.push({ model: m.name, reasons: guard.reasons });
      log(`REFUSED ${m.name}: ${guard.reasons.join("; ")}`);
      continue;
    }
    try {
      const loaded = ((await client.ps()).models ?? [])
        .map((x) => x.name)
        .filter((n) => n !== m.name);
      if (loaded.length && !opts.ignoreLoaded) {
        summary.refused.push({
          model: m.name,
          reasons: [
            `another model is loaded: ${loaded.join(", ")} (run \`ollama stop\` on it, or pass --ignore-loaded)`,
          ],
        });
        log(`REFUSED ${m.name}: another model is loaded: ${loaded.join(", ")}`);
        continue;
      }
    } catch (e) {
      summary.stopped = `cannot reach Ollama: ${e.message}`;
      break;
    }
    const preset = presetFor(product, m.name);
    const cases = expandSuite(suite, {
      model: m.name,
      preset,
      product,
      opts,
      agentTools,
    });
    const done = doneKeys(readRecords(file), { retryErrors: opts.retryErrors });
    const engine = await client.describe?.(m.name).catch(() => undefined);
    const t0 = Date.now();
    let consecutiveErrors = 0;
    log(`== ${m.name}: ${cases.length} cases x ${passes} pass(es)`);
    try {
      outer: for (let pass = 1; pass <= passes; pass++) {
        for (const c of cases) {
          const key = keyFor(suite.suite, m.name, c, pass, cfg);
          if (done.has(key)) {
            summary.skipped++;
            continue;
          }
          if (signal?.aborted) {
            summary.stopped = "interrupted";
            break outer;
          }
          const why = budget.exhausted();
          if (why) {
            summary.stopped = why;
            break outer;
          }
          if (Date.now() - t0 > modelMaxMs) {
            summary.stopped = `per-model time limit for ${m.name}`;
            break outer;
          }
          const started = Date.now();
          let reply, cls, score, error;
          try {
            budget.spend(1);
            reply = await client.chat({
              model: m.name,
              messages: c.messages,
              tools: c.sendTools ? c.tools : undefined,
              stream: c.stream,
              options: {
                temperature: cfg.temperature ?? c.temperature,
                num_predict: cfg.numPredict ?? c.numPredict,
                num_ctx: opts.numCtx ?? c.numCtx,
                seed: cfg.seed,
              },
              // an explicit --think wins; otherwise the lab's old rule: off, and
              // only for models that report the capability
              think:
                cfg.think != null
                  ? cfg.think
                  : m.capabilities?.includes("thinking")
                    ? c.think
                    : undefined,
              toolChoice: cfg.toolChoice,
              bodyExtra: cfg.bodyExtra,
              style: c.style ?? undefined,
              api: cfg.api,
              keepAlive: "2m",
            });
            if (suite.kind === "reviewer")
              ({ cls, score } = reviewScore(product, c, reply));
            else {
              cls = classifyReply(reply, c.tools, product, c.style);
              score = scoreReply(cls, c.expect, c.tools);
            }
            consecutiveErrors = 0;
          } catch (e) {
            if (!(e instanceof LabError)) throw e;
            if (e.kind === "aborted") {
              summary.stopped = "interrupted";
              break outer;
            }
            error = e;
            consecutiveErrors++;
          }
          const rec = recordFor({
            suite,
            model: m.name,
            c,
            pass,
            reply,
            cls,
            score,
            error,
            ms: Date.now() - started,
            cfg,
            engine,
          });
          appendRecord(file, rec, roots);
          error ? summary.errors++ : summary.ran++;
          log(
            `${key} -> ${rec.outcome}${score ? (score.valid ? " valid" : " invalid") : ""} ${rec.ms} ms`,
          );
          if (consecutiveErrors >= 3) {
            summary.stopped = `3 consecutive errors on ${m.name}; last: ${error.message}`;
            break outer;
          }
        }
      }
    } finally {
      const ok = await client.unload(m.name);
      log(ok ? `unloaded ${m.name}` : `could not confirm unload of ${m.name}`);
    }
    if (summary.stopped) break;
    if (mi < models.length - 1) {
      log(`cooldown ${(cooldownMs / 1000).toFixed(0)} s`);
      await sleep(cooldownMs, signal);
    }
  }
  return summary;
}

export { GB };
