/**
 * Table-lookup hints from the metadata a server already returns. Pure: the
 * caller fetches the JSON (llama.cpp /props, Ollama /api/show, LM Studio
 * /api/v0/models, vLLM or any /v1/models) and passes it in. The result is a
 * `DialectSignal` (the combining function was removed unused, see ROADMAP Q21). Design: plans/tool-dialect-detection.md, section 2.
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
  basis?: "chat-template" | "model-name" | "ollama-parser";
  /** Server says it can do tools (Ollama capabilities); not which parser. */
  toolsAdvertised?: boolean;
  /**
   * The server itself turns this model's text into structured tool calls
   * (Ollama named a parser that handles tool calls), so a call written as
   * text is not expected on that endpoint and recovery is not suggested.
   */
  serverParses?: boolean;
  /** Model name or path the hint came from, for logs. */
  modelName?: string;
  evidence: string[];
}

/** Confidence of a hint taken from a model name or architecture string. */
export const NAME_HINT_CONFIDENCE = 0.7;

/**
 * Model name to family. Qwen3-Coder and Qwen3.5 and later are checked before
 * other Qwen3 names because they write different markup (the Coder XML; the
 * Qwen3 and Qwen3-Next templates write Hermes JSON, read 2026-11-10). Llama is
 * left out on purpose: one name covers JSON, function-tag and pythonic forms
 * by version and server.
 */
const NAME_RULES: [RegExp, Dialect][] = [
  [
    /qwen[-._ ]?3[-._ ]?coder|coder[-._ ]?next|qwen[-._ ]?3\.[5-9]/i,
    "qwen-xml",
  ],
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

/**
 * Ollama parser names (the `parser` field of `/api/show`) to what they do.
 * Source: ollama/ollama `model/parsers/parsers.go` `ParserForName` (read
 * 2026-11-10) and the parser file named in each note. A name not in this table
 * is unverified: it maps to no dialect and does not set `serverParses`.
 * `renderer` names are not looked up here: they only build the prompt.
 */
export const OLLAMA_PARSERS: Record<
  string,
  { dialect?: Dialect; note: string }
> = {
  "qwen3-coder": {
    dialect: "qwen-xml",
    note: 'qwen3coder.go: finds toolOpenTag "<tool_call>" / toolCloseTag "</tool_call>" and "rewrites the <function=...> and <parameter=...> tags as XML"',
  },
  "qwen3.5": {
    dialect: "qwen-xml",
    note: 'qwen35.go: "handles qwen3.5 reasoning extraction and delegates post-thinking content (including XML tool calls) to Qwen3CoderParser"',
  },
  ornith: {
    dialect: "qwen-xml",
    note: 'parsers.go: case "ornith" returns &Qwen35Parser{}',
  },
  qwen3: {
    dialect: "hermes-json",
    note: 'qwen3.go: qwen3ToolOpenTag "<tool_call>", body json.Unmarshal into name/arguments',
  },
  "qwen3-thinking": {
    dialect: "hermes-json",
    note: "parsers.go: Qwen3Parser with thinking on",
  },
  "glm-4.7": {
    dialect: "glm-xml",
    note: 'glm47.go embeds GLM46Parser; glm46.go tags "<tool_call>", "<arg_key>", "<arg_value>"',
  },
  "glm-ocr": {
    dialect: "glm-xml",
    note: 'glmocr.go: "the GLM46 parser with thinking disabled"',
  },
  ministral: {
    dialect: "mistral",
    note: 'ministral.go: ministralToolCallsTag "[TOOL_CALLS]", ministralArgsTag "[ARGS]"',
  },
  harmony: {
    dialect: "harmony",
    note: "parsers.go: harmony.NewHarmonyMessageHandler()",
  },
  functiongemma: {
    dialect: "functiongemma",
    note: 'functiongemma.go: "<start_function_call>call:name{args}<end_function_call>"',
  },
  // Parses tool calls, but our dialect list has no matching form.
  deepseek3: {
    note: 'deepseek3.go: "<｜tool▁calls▁begin｜>" tokens; not our dsml (V3.2)',
  },
  gemma4: { note: 'gemma4.go: "<|tool_call>" ... "<tool_call|>"' },
  "gemma4-no-thinking": { note: "gemma4.go, thinking off" },
  "nemotron-3-nano": { note: 'nemotron3nano.go: "<tool_call>" open tag' },
};

/** llama.cpp `GET /props`: `chat_template` and `model_path`. */
export function hintFromLlamaCppProps(props: unknown): MetadataHint {
  const p = obj(props) ?? {};
  return fromTemplateOrName("llamacpp-props", str(p.chat_template), [
    str(p.model_path),
  ]);
}

/**
 * Ollama `POST /api/show`: `parser`, `renderer`, `template`, `capabilities`,
 * `details.family`, `model_info["general.architecture"]`. Models served
 * through a renderer/parser (`template_source: "renderer_parser"`) show the
 * template `{{ .Prompt }}`, so the parser name is read first, then the
 * template, then the model name. The `tools` capability only says the server
 * has some way to take tools for this model.
 */
export function hintFromOllamaShow(
  show: unknown,
  model?: string,
): MetadataHint {
  const s = obj(show) ?? {};
  const details = obj(s.details);
  const info = obj(s.model_info);
  const caps = Array.isArray(s.capabilities) ? s.capabilities : undefined;
  const names = [
    model,
    str(info?.["general.basename"]),
    str(details?.family),
    str(info?.["general.architecture"]),
  ];
  const parser = str(s.parser);
  const renderer = str(s.renderer);
  const entry =
    parser && Object.hasOwn(OLLAMA_PARSERS, parser)
      ? OLLAMA_PARSERS[parser]
      : undefined;
  let hint: MetadataHint;
  if (entry?.dialect) {
    hint = {
      source: "ollama-show",
      signal: { dialect: entry.dialect, confidence: 0.95 },
      basis: "ollama-parser",
      modelName: names.find((n) => !!n),
      evidence: [`ollama parser "${parser}" -> ${entry.dialect}`],
    };
  } else {
    hint = fromTemplateOrName("ollama-show", str(s.template), names);
    if (parser) {
      hint.evidence.push(
        entry
          ? `ollama parser "${parser}" has no matching dialect`
          : `ollama parser "${parser}" not in the verified table`,
      );
    }
  }
  if (entry) hint.serverParses = true;
  if (renderer) hint.evidence.push(`ollama renderer "${renderer}"`);
  if (caps) {
    hint.toolsAdvertised = caps.includes("tools");
    hint.evidence.push(
      hint.toolsAdvertised
        ? `capabilities include tools${caps.includes("thinking") ? " and thinking" : ""}`
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
