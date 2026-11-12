import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

import type { RequestOptions } from "../index.js";
import { editConfigFile, getContinueGlobalPath } from "../util/paths.js";
import { networkFetch } from "../util/networkFetch.js";

import { setOpenRouterCatalog } from "./utils/catalogPricing.js";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_BYTES,
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  validateCatalog,
  type ModelCatalog,
} from "./openRouterCatalog.js";

/**
 * The downloaded OpenRouter list, kept as a dated file in the global folder
 * (`model-catalog/openrouter.json`). Written only when the person asks for
 * it (Pull now, Refresh, `continuous models refresh`); read, never fetched,
 * everywhere else. Holds public catalogue data and nothing else.
 */

export function modelCatalogDir(): string {
  return path.join(getContinueGlobalPath(), "model-catalog");
}

export function openRouterCatalogPath(): string {
  return path.join(modelCatalogDir(), "openrouter.json");
}

/** The cached list, or undefined when there is none or it cannot be trusted. */
export function readOpenRouterCatalog(
  file = openRouterCatalogPath(),
): ModelCatalog | undefined {
  try {
    if (fs.statSync(file).size > MAX_CATALOG_BYTES) return undefined;
    return validateCatalog(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Write through a temporary file so a reader never sees a half-written list. */
export function writeOpenRouterCatalog(
  catalog: ModelCatalog,
  file = openRouterCatalogPath(),
): void {
  const text = JSON.stringify(catalog);
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

/**
 * Put the copy on disk (if any) in front of the cost functions of this
 * process. A local read; never fetches. `maxAgeDays` is for a dollar budget:
 * a list older than that prices nothing.
 */
export function loadOpenRouterPrices(
  opts: { maxAgeDays?: number; file?: string } = {},
): ModelCatalog | undefined {
  const catalog = readOpenRouterCatalog(opts.file);
  setOpenRouterCatalog(catalog, { maxAgeDays: opts.maxAgeDays });
  return catalog;
}

/**
 * Download the public list and keep it. One GET, no key, no body. Throws with
 * a short message when the host cannot be reached or the answer is not a
 * model list; the cached file is left as it was.
 */
export async function pullOpenRouterCatalog(
  requestOptions?: RequestOptions,
  opts: { file?: string; now?: () => Date } = {},
): Promise<ModelCatalog> {
  const response = await networkFetch(
    OPENROUTER_MODELS_URL,
    { headers: { accept: "application/json" } },
    requestOptions,
  );
  if (!response.ok) {
    throw new Error(`openrouter.ai answered ${response.status}`);
  }
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (length > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("openrouter.ai did not return a model list");
  }
  const models = parseOpenRouterModels(body);
  if (models.length === 0) {
    throw new Error("openrouter.ai returned no models");
  }
  const catalog: ModelCatalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: OPENROUTER_MODELS_URL,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    models,
  };
  writeOpenRouterCatalog(catalog, opts.file);
  // Prices apply to the next request of this process, with no restart
  setOpenRouterCatalog(catalog);
  return catalog;
}

/**
 * Whether to offer the download: `ask` (default) shows the dialog until it is
 * answered for good, `never` stays quiet. Nothing here fetches.
 */
export type ModelCatalogPolicy = "ask" | "never";

const POLICIES: ModelCatalogPolicy[] = ["ask", "never"];

function policyFile(): string {
  return path.join(modelCatalogDir(), "policy.json");
}

/**
 * `modelCatalog:` in the user-level config.yaml, the file the settings page
 * writes (as `terminal:` is). When that file does not exist the choice is
 * kept beside the cache instead, so it is never lost.
 */
export function readModelCatalogPolicy(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
  standIn = policyFile(),
): ModelCatalogPolicy {
  try {
    if (fs.existsSync(file)) {
      const v = (YAML.parse(fs.readFileSync(file, "utf8")) as any)
        ?.modelCatalog;
      if (POLICIES.includes(v)) return v;
    }
  } catch {
    // fall through to the default
  }
  try {
    const v = JSON.parse(fs.readFileSync(standIn, "utf8"))?.modelCatalog;
    if (POLICIES.includes(v)) return v;
  } catch {
    // no stored choice
  }
  return "ask";
}

export function saveModelCatalogPolicy(policy: ModelCatalogPolicy): boolean {
  if (!POLICIES.includes(policy)) return false;
  let saved = false;
  try {
    editConfigFile(
      (c) => c,
      (config) => {
        saved = true;
        const next: Record<string, unknown> = { ...config };
        if (policy === "ask") delete next.modelCatalog;
        else next.modelCatalog = policy;
        return next as typeof config;
      },
      "main",
    );
  } catch {
    saved = false;
  }
  if (saved) {
    // One source of truth: drop the stand-in file if it exists
    try {
      fs.rmSync(policyFile(), { force: true });
    } catch {
      // harmless
    }
    return true;
  }
  try {
    fs.mkdirSync(modelCatalogDir(), { recursive: true });
    fs.writeFileSync(policyFile(), JSON.stringify({ modelCatalog: policy }));
    return true;
  } catch {
    return false;
  }
}
