/**
 * Table-lookup hints from the metadata a server already returns. Pure: the
 * caller fetches the JSON (llama.cpp /props, Ollama /api/show, LM Studio
 * /api/v0/models, vLLM or any /v1/models) and passes it in. The result feeds
 * `decideDialect({ metadata })`. Design: plans/tool-dialect-detection.md, section 2.
 */
import {
  type Dialect,
  type DialectSignal,
  dialectFromChatTemplate,
} from "./toolDialectDetect.js";

export type MetadataSource =
  "llamacpp-props" | "ollama-show" | "lmstudio-models" | "openai-models";

export interface MetadataHint {
  source: MetadataSource;
  /** The family signal, when the metadata names one. */
  signal?: DialectSignal;
  /** Template-derived hints are stronger than name-derived ones. */
  basis?: "chat-template" | "model-name";
  /** Server says it can do tools (Ollama capabilities); not which parser. */
  toolsAdvertised?: boolean;
  /** Model name or path the hint came from, for logs. */
  modelName?: string;
  evidence: string[];
}

/** Confidence of a hint taken from a model name or architecture string. */
export const NAME_HINT_CONFIDENCE = 0.7;

/**
 * Model name to family. Qwen3-Coder is checked before other Qwen3 names
 * because the two write different markup. Llama is left out on purpose: one
 * name covers JSON, function-tag and pythonic forms by version and server.
 */
const NAME_RULES: [RegExp, Dialect][] = [
  [/qwen3[-._ ]?coder|coder[-._ ]?next|qwen3[-._ ]?next/i, "qwen-xml"],
  [/qwen[-._ ]?3|qwen[-._ ]?2[.-]?5|qwq|hermes/i, "hermes-json"],
  [/glm[-._ ]?4/i, "glm-xml"],
  [/kimi[-._ ]?k2/i, "kimi-tokens"],
  [/gpt[-._ ]?oss/i, "harmony"],
  [/deepseek[-._ ]?v?3[.-]?2|deepseek[-._ ]?v4/i, "dsml"],
  [/minimax[-._ ]?m2/i, "minimax-xml"],
  [/functiongemma/i, "functiongemma"],
  [/mistral|mixtral|devstral|ministral/i, "mistral"],
];

/** A hint from a model id, file path or architecture string alone. */
export function dialectFromModelName(
  name: string | null | undefined,
): DialectSignal | undefined {
  if (!name) return undefined;
  for (const [re, dialect] of NAME_RULES) {
    if (re.test(name)) return { dialect, confidence: NAME_HINT_CONFIDENCE };
  }
  return undefined;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function fromTemplateOrName(
  source: MetadataSource,
  template: string | undefined,
  names: (string | undefined)[],
): MetadataHint {
  const evidence: string[] = [];
  const modelName = names.find((n) => !!n);
  const t = dialectFromChatTemplate(template);
  if (t) {
    evidence.push(`chat template: ${t.evidence}`);
    return {
      source,
      signal: { dialect: t.dialect, confidence: t.confidence },
      basis: "chat-template",
      modelName,
      evidence,
    };
  }
  if (template) evidence.push("chat template present, no tool markup in it");
  for (const n of names) {
    const s = dialectFromModelName(n);
    if (s) {
      evidence.push(`name "${n}" matches ${s.dialect}`);
      return { source, signal: s, basis: "model-name", modelName, evidence };
    }
  }
  evidence.push("no family recognised");
  return { source, modelName, evidence };
}

/** llama.cpp `GET /props`: `chat_template` and `model_path`. */
export function hintFromLlamaCppProps(props: unknown): MetadataHint {
  const p = obj(props) ?? {};
  return fromTemplateOrName("llamacpp-props", str(p.chat_template), [
    str(p.model_path),
  ]);
}

/**
 * Ollama `POST /api/show`: `template`, `capabilities`, `details.family`,
 * `model_info["general.architecture"]`. The `tools` capability only says the
 * server has some parser for this model.
 */
export function hintFromOllamaShow(
  show: unknown,
  model?: string,
): MetadataHint {
  const s = obj(show) ?? {};
  const details = obj(s.details);
  const info = obj(s.model_info);
  const caps = Array.isArray(s.capabilities) ? s.capabilities : undefined;
  const hint = fromTemplateOrName("ollama-show", str(s.template), [
    model,
    str(info?.["general.basename"]),
    str(details?.family),
    str(info?.["general.architecture"]),
  ]);
  if (caps) {
    hint.toolsAdvertised = caps.includes("tools");
    hint.evidence.push(
      hint.toolsAdvertised
        ? "capabilities include tools"
        : "capabilities do not include tools",
    );
  }
  return hint;
}

/** LM Studio `GET /api/v0/models`: the entry whose `id` is `model`, else none. */
export function hintFromLmStudioModels(
  list: unknown,
  model: string,
): MetadataHint {
  const data = obj(list)?.data;
  const entry = Array.isArray(data)
    ? data.map(obj).find((e) => e?.id === model)
    : undefined;
  if (!entry) {
    return {
      source: "lmstudio-models",
      modelName: model,
      evidence: ["model not in the listing"],
    };
  }
  return fromTemplateOrName("lmstudio-models", undefined, [
    str(entry.id),
    str(entry.arch),
  ]);
}

/**
 * A plain `/v1/models` listing (vLLM, SGLang, gateways): `id`, and `root`
 * when the server gives the Hugging Face path behind a renamed
 * `--served-model-name`. `owned_by` is ignored: gateways set it freely.
 */
export function hintFromOpenAiModels(
  list: unknown,
  model: string,
): MetadataHint {
  const data = obj(list)?.data;
  const entry = Array.isArray(data)
    ? data.map(obj).find((e) => e?.id === model)
    : undefined;
  return fromTemplateOrName("openai-models", undefined, [
    str(entry?.root),
    str(entry?.id) ?? model,
  ]);
}
