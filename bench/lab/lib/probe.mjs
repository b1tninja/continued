// First-contact probe for `--think`. A model that rejects the think setting
// (Ollama answers an HTTP error for a model without the `thinking`
// capability) would otherwise fail every case, be recorded as an error, and
// trip the three-failures breaker with a message nobody reads. One tiny
// request with the configured setting finds that out first and stops the
// run with the engine's own words.
import { LabError } from "./ollama.mjs";
import { thinkValue } from "./transports.mjs";

/** Whether the run asks for something the probe can check. */
export const needsThinkProbe = (cfg) =>
  cfg?.api !== "llamacpp-raw" && thinkValue(cfg?.think) !== undefined;

/**
 * Send one tiny request with the configured think value.
 * Returns { skipped: true } when there is nothing to check, { ok: true } when
 * the engine accepted it, { ok: false, message } when it refused. An abort is
 * rethrown. Any other failure is reported, not hidden.
 */
export async function probeThink({ client, model, cfg, budget, signal }) {
  if (!needsThinkProbe(cfg)) return { skipped: true };
  if (signal?.aborted) throw new LabError("aborted", "aborted");
  budget?.spend(1);
  try {
    await client.chat({
      model,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      stream: false,
      options: { temperature: 0, num_predict: 8, seed: cfg.seed },
      think: cfg.think,
      bodyExtra: cfg.bodyExtra,
      api: cfg.api,
      keepAlive: "2m",
    });
    return { ok: true, think: cfg.think };
  } catch (e) {
    if (!(e instanceof LabError)) throw e;
    if (e.kind === "aborted") throw e;
    return { ok: false, kind: e.kind, message: e.message, think: cfg.think };
  }
}

/** The sentence a refused probe becomes in the summary and the log. */
export const thinkRefusal = (model, r) =>
  `--think ${r.think} was refused on the first request to ${model} (${r.kind}): ${r.message}. Nothing was recorded for this model; drop --think or pick a model that supports it.`;
