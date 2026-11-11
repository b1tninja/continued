// The guards that keep a big model on a small machine from hurting it:
// reported-size limits, an exclusive-model check, request and wall-clock
// budgets, and the facts they rest on (nvidia-smi, RAM, the models drive).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GB = 1e9;

/** Where Ollama keeps its models: $OLLAMA_MODELS, else ~/.ollama/models. */
export function modelsDir(env = process.env) {
  return env.OLLAMA_MODELS || path.join(os.homedir(), ".ollama", "models");
}

function freeBytes(dir) {
  try {
    let d = dir;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return {
      free: Number(s.bavail) * Number(s.bsize),
      total: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    return undefined;
  }
}

/** Real VRAM from nvidia-smi (the OS adapter figure is a 32-bit cap). */
export function readNvidiaSmi(exec = execFileSync) {
  try {
    const out = exec(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const gpus = String(out)
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [name, total, used, free] = line.split(",").map((s) => s.trim());
        return {
          name,
          totalGB: (Number(total) * 1.048576) / 1000,
          usedGB: (Number(used) * 1.048576) / 1000,
          freeGB: (Number(free) * 1.048576) / 1000,
        };
      })
      .filter((g) => Number.isFinite(g.totalGB));
    return gpus.length ? gpus : undefined;
  } catch {
    return undefined;
  }
}

export function machineFacts({ env = process.env, exec } = {}) {
  const dir = modelsDir(env);
  const disk = freeBytes(dir);
  return {
    gpus: readNvidiaSmi(exec),
    ramTotalGB: os.totalmem() / GB,
    ramFreeGB: os.freemem() / GB,
    modelsDir: dir,
    modelsDirFromEnv: Boolean(env.OLLAMA_MODELS),
    modelsDiskFreeGB: disk ? disk.free / GB : undefined,
    modelsDiskTotalGB: disk ? disk.total / GB : undefined,
  };
}

/**
 * Whether a model may be run under the limits. `sizeBytes` is what Ollama
 * reports for the model (weights on disk), a floor for what it needs once
 * loaded with a context; the limits are the owner's to set.
 */
export function modelGuard(
  { name, sizeBytes, capabilities = [], family = "" },
  limits,
  facts,
) {
  const reasons = [];
  const gb = sizeBytes / GB;
  if (capabilities.includes("embedding"))
    reasons.push("embedding model, not a chat model");
  if (/ocr/i.test(family) || /ocr/i.test(name))
    reasons.push("OCR model, not a tool-capable chat model");
  if (limits.maxVramGB != null && gb > limits.maxVramGB)
    reasons.push(
      `size ${gb.toFixed(1)} GB exceeds --max-vram ${limits.maxVramGB}`,
    );
  if (limits.maxRamGB != null && gb > limits.maxRamGB)
    reasons.push(
      `size ${gb.toFixed(1)} GB exceeds --max-ram ${limits.maxRamGB}`,
    );
  const free = facts?.gpus?.[0]?.freeGB;
  if (free != null && gb > free)
    reasons.push(
      `size ${gb.toFixed(1)} GB exceeds the ${free.toFixed(1)} GB of VRAM free now`,
    );
  return { ok: reasons.length === 0, reasons };
}

/** Request and wall-clock budget for one run. */
export class Budget {
  constructor({ maxRequests = 60, maxMs = 30 * 60_000, now = Date.now } = {}) {
    this.maxRequests = maxRequests;
    this.maxMs = maxMs;
    this.now = now;
    this.started = now();
    this.requests = 0;
  }
  spend(n = 1) {
    this.requests += n;
  }
  /** A reason to stop, or null. */
  exhausted() {
    if (this.requests >= this.maxRequests)
      return `request budget of ${this.maxRequests} spent`;
    if (this.now() - this.started >= this.maxMs)
      return `wall-clock budget of ${(this.maxMs / 60_000).toFixed(1)} min spent`;
    return null;
  }
  remainingMs() {
    return Math.max(0, this.maxMs - (this.now() - this.started));
  }
}

/** A sleep that ends early when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
