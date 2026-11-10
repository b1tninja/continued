/**
 * Per-family request rules for the models the benchmark has not measured yet
 * (plans/model-families-2026-11.md; roadmap rows I2 and I4). Data only: what a
 * vendor or AWS page says, with its URL and the date it was read. Nothing here
 * was probed against Bedrock; every entry is `unprobed` until a run of
 * `bench/probe.mjs` (probes in bench/probes/families.yaml) says otherwise, and
 * the entry changes to `probed` with the run's date in the same commit.
 *
 * Only `converseReasoning` is read by code (`bedrockReasoningFields`), and only
 * where AWS documents the Converse field. The rest is the table the probes are
 * checked against and the CLI's model picker can show.
 *
 * Two copies, this one and packages/openai-adapters/src/apis/bedrockFamilyRules.ts
 * (core cannot import that package; see `bedrockSupportsOneHourCache`).
 * bedrockReasoningFields.vitest.ts fails if they disagree.
 */

export type FamilyStatus = "unprobed" | "probed";

/** How a Converse request switches reasoning for a family. */
export interface ConverseReasoningRule {
  /** The key put in `additionalModelRequestFields`. */
  field: string;
  /** Values the vendor documents, weakest first. */
  values: string[];
  /** The value that turns reasoning off, when there is one. */
  off?: string;
  /** What the model does when the field is absent. */
  defaultWhenAbsent: string;
}

export interface FamilyRule {
  id: string;
  /** Matches the Bedrock model id with or without a geography prefix. */
  match: RegExp;
  status: FamilyStatus;
  /** Date the sources were read, YYYY-MM-DD. */
  read: string;
  /** Vendor and AWS pages the entry rests on. */
  sources: string[];
  /** Converse field wired into the request builder; absent means none is. */
  converseReasoning?: ConverseReasoningRule;
  /**
   * Fields the vendor documents for its own API or a serving stack, to try in
   * the probe. Not sent by any code.
   */
  candidateReasoningFields: string[];
  /** Tool-choice values the sources claim; `unknown` when no page says. */
  toolChoice: "auto-any-tool" | "unknown" | "disputed";
  /** Sampling constraints the sources state, plain words. */
  sampling: string;
  /** The tool-call dialect id from core/util/toolDialectDetect.ts. */
  dialect: string;
  /** Limits from the AWS card: context tokens and max output tokens. */
  contextLength?: number;
  maxOutputTokens?: number;
  /** One line per known quirk. */
  quirks: string[];
}

const AWS = "https://docs.aws.amazon.com/bedrock/latest/userguide";

export const FAMILY_RULES: FamilyRule[] = [
  {
    id: "kimi-k3",
    match: /(^|\.)moonshotai\.kimi-k3(\.1)?$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-moonshot-ai-kimi-k3.html`,
      `${AWS}/model-card-moonshot-ai-kimi-k3-1-highspeed.html`,
      "https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model",
    ],
    // AWS: Converse accepts reasoning_effort in additionalModelRequestFields
    // but does not validate it for this model. Unset means max.
    converseReasoning: {
      field: "reasoning_effort",
      values: ["low", "medium", "high", "xhigh", "max"],
      off: "none",
      defaultWhenAbsent: "max",
    },
    candidateReasoningFields: ["reasoning_effort"],
    toolChoice: "disputed",
    sampling:
      "third-party pages say temperature and top_p are fixed and a 400 follows; no vendor page found",
    dialect: "kimi-tokens",
    contextLength: 1_000_000,
    quirks: [
      "Converse fails (InternalServerException) when reasoning content from earlier turns is replayed; AWS recommends Responses or Chat Completions",
      "output burns 10x of the token quota",
      "Moonshot's page lists low, high and max; AWS adds none, medium and xhigh",
    ],
  },
  {
    id: "kimi-k2-thinking",
    match: /(^|\.)moonshot(ai)?\.kimi-k2-thinking$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [`${AWS}/model-card-moonshot-ai-kimi-k2-thinking.html`],
    candidateReasoningFields: [],
    toolChoice: "unknown",
    sampling: "no page found",
    dialect: "kimi-tokens",
    contextLength: 256_000,
    maxOutputTokens: 16_384,
    quirks: [
      "always reasons; there is no switch",
      "bedrock-runtime id is moonshot.kimi-k2-thinking, Mantle id is moonshotai.kimi-k2-thinking",
      "Legacy, end of life 2027-03-30",
    ],
  },
  {
    id: "kimi-k2.5",
    match: /(^|\.)moonshotai\.kimi-k2\.5$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-moonshot-ai-kimi-k2-5.html`,
      "https://huggingface.co/moonshotai/Kimi-K2.5",
    ],
    // Moonshot API: thinking {type: disabled}; vLLM and SGLang:
    // chat_template_kwargs {thinking: false}. No Bedrock field is documented.
    candidateReasoningFields: [
      "thinking",
      "chat_template_kwargs.thinking",
      "reasoning_effort",
    ],
    toolChoice: "unknown",
    sampling: "temperature 1.0 thinking, 0.6 instant, top_p 0.95 (vendor card)",
    dialect: "kimi-tokens",
    contextLength: 256_000,
    maxOutputTokens: 16_384,
    quirks: ["replay the full assistant message with reasoning_content"],
  },
  {
    id: "glm-5",
    match: /(^|\.)zai\.glm-5$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-zai-glm-5.html`,
      "https://docs.z.ai/guides/capabilities/thinking-mode",
      "https://huggingface.co/zai-org/GLM-5",
    ],
    candidateReasoningFields: [
      "thinking",
      "chat_template_kwargs.enable_thinking",
    ],
    toolChoice: "unknown",
    sampling:
      "1.0 / 0.95 for reasoning, 0.7 / 0.95 for SWE-bench (vendor card)",
    dialect: "glm-xml",
    contextLength: 200_000,
    maxOutputTokens: 128_000,
    quirks: [
      "thinking is on by default; vendor API takes thinking.type enabled or disabled",
      "clear_thinking false keeps prior reasoning and needs it returned in order",
    ],
  },
  {
    id: "minimax-m2.5",
    match: /(^|\.)minimax\.minimax-m2\.5$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-minimax-minimax-m2-5.html`,
      "https://huggingface.co/MiniMaxAI/MiniMax-M2.5",
      "https://platform.minimax.io/docs/api-reference/text-openai-api",
    ],
    candidateReasoningFields: ["reasoning_split", "thinking"],
    toolChoice: "unknown",
    sampling:
      "recommended temperature 1.0, top_p 0.95, top_k 40; the vendor API ignores temperature, top_p and penalties",
    dialect: "minimax-xml",
    contextLength: 196_000,
    maxOutputTokens: 8_192,
    quirks: [
      "thinking tokens count toward the limit; a small limit gives finish_reason length with empty content",
      "thinking stays in <think> tags in content unless reasoning_split is true",
      "Mantle listed it but did not answer in a March 2026 third-party test; AWS lists it on Mantle now",
    ],
  },
  {
    id: "nemotron-3-super",
    match: /(^|\.)nvidia\.nemotron-super-3-120b$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-nvidia-nemotron-super-3-120b.html`,
      "https://docs.vllm.ai/en/stable/api/vllm/parser/nemotron_v3/",
    ],
    // AWS: effort none, low, medium, high, with no field named.
    candidateReasoningFields: [
      "reasoning_effort",
      "chat_template_kwargs.enable_thinking",
      "chat_template_kwargs.low_effort",
      "reasoning_budget",
    ],
    toolChoice: "unknown",
    sampling: "no page found",
    dialect: "qwen-xml",
    contextLength: 256_000,
    maxOutputTokens: 32_768,
    quirks: [
      "vLLM serves tools with the qwen3_coder parser",
      "force_nonempty_content is advised for coding agents by Cloudflare (unverified)",
    ],
  },
  {
    id: "grok-4.6",
    match: /(^|\.)xai\.grok-4\.[67]$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-xai-grok-4-6.html`,
      "https://docs.x.ai/docs/guides/reasoning",
    ],
    // Responses: reasoning {effort}; Chat Completions: reasoning_effort.
    candidateReasoningFields: ["reasoning_effort", "reasoning.effort"],
    toolChoice: "unknown",
    sampling:
      "presencePenalty, frequencyPenalty and stop return an error on xAI's reasoning models",
    dialect: "native-structured",
    contextLength: 500_000,
    quirks: [
      "reasoning cannot be turned off; effort low, medium, high, xhigh",
      "on bedrock-runtime only us.xai.grok-4.6 and global.xai.grok-4.6 answer; xai.grok-4.6 is the Mantle id with path /openai/v1",
      "Chat Completions does not return reasoning tokens",
    ],
  },
  {
    id: "gpt-oss",
    match: /(^|\.)openai\.gpt-oss-(120b|20b)(-1:0)?$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-openai-gpt-oss-120b.html`,
      "https://huggingface.co/openai/gpt-oss-120b",
    ],
    // The Hugging Face card sets effort in the system prompt ("Reasoning:
    // high"); no Bedrock field is documented.
    candidateReasoningFields: ["reasoning_effort"],
    toolChoice: "unknown",
    sampling: "no page found",
    dialect: "harmony",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    quirks: [
      "refuses stopSequences on Converse (handled by isStopSequencesUnsupportedError)",
      "reasoning is on by default; low, medium, high",
      "a small max_tokens can leave content null",
    ],
  },
];

/** The rule for a Bedrock model id, or undefined. */
export function familyRuleFor(modelId: string): FamilyRule | undefined {
  return FAMILY_RULES.find((r) => r.match.test(modelId));
}
