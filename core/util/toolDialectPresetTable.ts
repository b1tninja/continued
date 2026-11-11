/**
 * The preset rows (types and lookup: toolDialectPresets.ts). Data only.
 *
 * Evidence rules: `bedrockTools`, `nativeOnConverse` and `measured` come from
 * the live Bedrock Converse run of 2026-11-10 (plans/live-tool-call-findings.md,
 * 8 prompts per model). `textDialect` comes from the family's chat template or
 * vendor guide as read on `readOn` (plans/tool-dialect-reference.md). A
 * `serverParser` is set only where a model card, a deployment guide or the
 * vLLM docs named it; the vLLM registry
 * (github.com/vllm-project/vllm vllm/tool_parsers/__init__.py, read 2026-11-10)
 * is the check that a name exists. Llama.cpp and Ollama template notes are not
 * recorded: none was verified.
 */
import type { DialectPreset } from "./toolDialectPresets.js";

const READ = "2026-11-10";
const REF = "plans/tool-dialect-reference.md";
const LIVE = "plans/live-tool-call-findings.md";
const VLLM_DOCS = "https://docs.vllm.ai/en/latest/features/tool_calling/";
const THINK: [string, string] = ["<think>", "</think>"];

export const TOOL_DIALECT_PRESETS: DialectPreset[] = [
  {
    id: "nemotron-3",
    label: "NVIDIA Nemotron 3 (Super, Nano, Ultra)",
    match: [/nemotron[-._ ]?(?:(?:super|nano|ultra)[-._ ]?)?3(?!\d)/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Nemotron 3 Super and Nano 3: structured 100%, no leak",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "Super chat template writes calls in the Qwen3-Coder form (read 2026-11-10); never prompted for it by us",
    },
    recoverWith: "qwen-xml",
    thinkingTags: THINK,
    serverParser: {
      vllm: "qwen3_coder",
      basis: "model-card",
      note: "Nano 3 card also sets --reasoning-parser nano_v3 with its plugin file; the Super recipe uses nemotron_v3",
    },
    source: [
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16/raw/main/chat_template.jinja",
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
      "https://recipes.vllm.ai/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
    ],
    readOn: READ,
    unverified: [
      "Nemotron 3 Ultra and 3.5: not read; assumed to follow the family",
      "the Super recipe page was read only through a search summary",
    ],
  },
  {
    id: "nemotron-h",
    label: "NVIDIA Nemotron-H / Nano v2",
    match: [
      /nemotron[-._ ]?h(?![a-z])/,
      /nemotron[-._ ]?(?:nano[-._ ]?)?(?:9b|12b)[-._ ]?v2/,
    ],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "toolcall-json",
    promptStyle: {
      style: "toolcall-json",
      evidence:
        'Nano-9B-v2 template instructs <TOOLCALL>[{"name","arguments"}]</TOOLCALL> (read 2026-11-10); no parser built',
    },
    source: [
      "https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2/raw/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "format read in the Nano-9B-v2 chat template only; Nemotron-H-4B/8B/47B templates were not read",
      "a parser plugin (nemotron_toolcall_parser_no_streaming.py) is named in a repo commit listing seen through search; its use was not read",
      "no recovery parser: no corpus fixture and no live capture",
    ],
  },
  {
    id: "llama-nemotron",
    label: "Llama-3.x Nemotron (Super 49B, Ultra 253B)",
    match: [
      /llama[-._ ]?3[-._ ]?\d?[-._ ]?nemotron/,
      /llama[-._ ]nemotron/,
      /nemotron[-._ ](?:super|ultra|nano)[-._ ]?(?:49|51|70|8)b/,
    ],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "toolcall-json",
    promptStyle: {
      style: "toolcall-json",
      evidence:
        "Super 49B v1.5 template instructs the <TOOLCALL> form (read 2026-11-10); no parser built",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "llama_nemotron_json",
      basis: "model-card",
      note: "needs --tool-parser-plugin llama_nemotron_toolcall_parser_no_streaming.py from the model repository (Super 49B v1.5 card, vllm==0.9.2)",
    },
    source: [
      "https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1_5",
      "https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-v1_5/raw/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "Super 49B v1.5 only; Ultra 253B and v1 were not read",
      "no recovery parser: no corpus fixture and no live capture",
    ],
  },
  {
    id: "qwen3-coder",
    label: "Qwen3-Coder (30B-A3B, 480B, Coder-Next)",
    // Not Qwen3-Next: its template is the Hermes JSON form (qwen3 row).
    match: [/qwen[-._ ]?3[-._ ]?coder|coder[-._ ]?next/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "most",
    measured:
      "Qwen3-Coder 30B: structured 7/8, 1/8 wrote a <function=...> block as text (qwen-xml recovered it); Coder-Next structured",
    textDialect: "qwen-xml",
    promptStyle: {
      style: "qwen-xml",
      evidence:
        "trained-in form; 1/8 Qwen3-Coder 30B replies wrote it as text and qwen-xml recovered it (live 2026-11-10)",
    },
    observedLeak: "qwen-xml",
    recoverWith: "qwen-xml",
    serverParser: {
      vllm: "qwen3_xml",
      basis: "vllm-docs",
      note: "qwen3_coder is also registered and is what the NVIDIA Nemotron 3 cards use for the same markup",
    },
    source: [
      "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/chat_template.jinja",
      "https://huggingface.co/Qwen/Qwen3-Coder-Next/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "qwen3",
    label: "Qwen3 (incl. Qwen3-Next), Qwen2.5, QwQ and Hermes",
    match: [/qwen[-._ ]?(?:3|2[.-]?5)|qwq|hermes/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "Qwen3 32B, Strata Qwen3.8 Flash and Ollama Qwen3.6: structured 100%, no leak",
    textDialect: "hermes-json",
    promptStyle: {
      style: "hermes-json",
      evidence:
        "Qwen3 and Hermes-3 templates instruct the <tool_call> JSON form (read 2026-11-10); 100% structured on Converse, so unprompted",
    },
    recoverWith: "hermes-json",
    thinkingTags: THINK,
    serverParser: {
      vllm: "hermes",
      basis: "vllm-docs",
      note: "the docs name Hermes 2/3, Qwen2.5 and QwQ; the Qwen3 template writes the same tags (read)",
    },
    source: [
      "https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/tokenizer_config.json",
      "https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct/raw/main/tokenizer_config.json",
      "https://huggingface.co/NousResearch/Hermes-3-Llama-3.1-8B/blob/main/tokenizer_config.json",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "Qwen3-Next-80B-A3B-Instruct template read 2026-11-10 (Hermes JSON: 'return a json object with function name and arguments within <tool_call></tool_call> XML tags'); the Thinking variant was not read; Bedrock tool support for Qwen3-Next was not measured",
      "Qwen3.5 and 3.6 templates were not read (issues report them on the Hermes or Coder pipeline)",
    ],
  },
  {
    id: "glm-5",
    label: "GLM-5",
    match: [/glm[-._ ]?5/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "GLM 5: structured 100%, no leak",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "assumed to follow GLM-4.7; 100% structured on Converse, so unprompted",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    source: [LIVE, REF],
    readOn: READ,
    unverified: [
      "GLM-5 template and parser were not read; the text dialect is assumed to follow GLM-4.7",
    ],
  },
  {
    id: "glm-4.7",
    label: "GLM-4.7 and 4.7-Flash",
    match: [/glm[-._ ]?4[-._ ]?7/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "GLM 4.7: structured 100%, no leak",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "GLM-4.7 template instructs the arg_key/arg_value form (read 2026-11-10); 100% structured on Converse",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    serverParser: { vllm: "glm47", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/zai-org/GLM-4.7/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "glm-4.5-4.6",
    label: "GLM-4.5, 4.5-Air and 4.6",
    match: [/glm[-._ ]?4[-._ ]?[56]/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "glm-xml",
    promptStyle: {
      style: "glm-xml",
      evidence:
        "GLM-4.5 and 4.6 templates instruct the arg_key/arg_value form (read 2026-11-10)",
    },
    recoverWith: "glm-xml",
    thinkingTags: THINK,
    serverParser: { vllm: "glm45", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/zai-org/GLM-4.5/blob/main/chat_template.jinja",
      "https://huggingface.co/zai-org/GLM-4.6/blob/main/chat_template.jinja",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "not run live; tools are offered because the 4.7 and 5 runs and the template agree",
    ],
  },
  {
    id: "kimi-k2-thinking",
    label: "Kimi K2 Thinking",
    match: [/kimi[-._ ]?k2[-._ ]?thinking/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "structured 8/8; one <think>...</think> block leaked into the text of a reply to a tool result",
    textDialect: "kimi-tokens",
    promptStyle: {
      style: "native",
      evidence:
        "8/8 structured on Converse (live 2026-11-10); the token form has no parser here",
    },
    observedLeak:
      "<think> block in text (lifted into reasoning by the Bedrock handlers)",
    thinkingTags: THINK,
    // Leaked into the text of a reply to a tool result (seen live 2026-11-10).
    thinkingInText: /kimi-k2-thinking/,
    serverParser: {
      vllm: "kimi_k2",
      basis: "vllm-docs",
      note: "named for Kimi-K2-Instruct",
    },
    source: [
      "https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/main/chat_template.jinja",
      "https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "kimi-k3",
    label: "Kimi K3 and K3.1",
    match: [/kimi[-._ ]?k3/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Kimi K3 and K3.1: structured 100%, no leak",
    textDialect: "kimi-tokens",
    promptStyle: {
      style: "native",
      evidence: "100% structured on Converse (live 2026-11-10)",
    },
    serverParser: {
      vllm: "kimi_k3",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; the docs and the K3 template were not read",
    },
    source: [LIVE, REF],
    readOn: READ,
    unverified: [
      "Kimi K3 template not read; the text dialect is assumed to follow K2",
    ],
  },
  {
    id: "kimi-k2",
    label: "Kimi K2 and K2.5",
    match: [/kimi[-._ ]?k2/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Kimi K2.5: structured 100%, no leak",
    textDialect: "kimi-tokens",
    promptStyle: {
      style: "native",
      evidence: "100% structured on Converse (live 2026-11-10)",
    },
    serverParser: {
      vllm: "kimi_k2",
      basis: "vllm-docs",
      note: "named for Kimi-K2-Instruct",
    },
    source: [
      "https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/main/chat_template.jinja",
      "https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "minimax-m2",
    label: "MiniMax M2 and M2.5",
    match: [/minimax/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "MiniMax M2 and M2.5: structured 100%, no leak",
    textDialect: "minimax-xml",
    promptStyle: {
      style: "native",
      evidence:
        "100% structured on Converse (live 2026-11-10); the vendor recommends a server parser over hand parsing",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "minimax_m2",
      basis: "model-card",
      note: "the M2 deployment guide pairs it with --reasoning-parser minimax_m2_append_think",
    },
    source: [
      "https://huggingface.co/MiniMaxAI/MiniMax-M2/raw/main/docs/vllm_deploy_guide.md",
      "https://huggingface.co/MiniMaxAI/MiniMax-M2/raw/main/docs/tool_calling_guide.md",
      "https://huggingface.co/MiniMaxAI/MiniMax-M2.5/blob/main/chat_template.jinja",
    ],
    readOn: READ,
  },
  {
    id: "deepseek-r1",
    label: "DeepSeek R1",
    match: [/deepseek[-._ ]?r1/],
    bedrockTools: "no",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured: "Bedrock refuses tools outright (2026-11-08)",
    textDialect: "deepseek-tokens",
    promptStyle: {
      style: "codeblock",
      evidence:
        "Bedrock refuses tools (2026-11-08) and the V3.1 card says tool calls work in non-thinking mode only; codeblock is untested on R1",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v3",
      basis: "vllm-docs",
      note: "named for DeepSeek-R1-0528 with tool_chat_template_deepseekr1.jinja",
    },
    source: [
      VLLM_DOCS,
      "https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/tokenizer_config.json",
    ],
    readOn: READ,
    unverified: [
      "whether R1 emits its history format reliably was not established",
    ],
  },
  {
    id: "deepseek-v3.2",
    label: "DeepSeek V3.2 and V4",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?(?:3[.-]?2|4)/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "DeepSeek V3.2: structured 8/8; all 8 also ended the text with a DSML function_calls fragment (always dropped)",
    textDialect: "dsml",
    promptStyle: {
      style: "native",
      evidence: "8/8 structured on Converse (live 2026-11-10)",
    },
    observedLeak: "DSML fragment after the structured call",
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v32",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; the docs page does not list it",
    },
    source: [
      "https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/main/encoding/encoding_dsv32.py",
      LIVE,
    ],
    readOn: READ,
    unverified: ["DeepSeek V4 was not read"],
  },
  {
    id: "deepseek-v3",
    label: "DeepSeek V3 and V3.1",
    match: [/deepseek[-._ ]?(?:chat[-._ ]?)?v?3/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "deepseek-tokens",
    promptStyle: {
      style: "native",
      evidence:
        "V3.1 card describes a hand-written system prompt for its token form; not measured, so native until measured",
    },
    thinkingTags: THINK,
    serverParser: {
      vllm: "deepseek_v31",
      basis: "vllm-docs",
      note: "deepseek_v31 for V3.1, deepseek_v3 for V3-0324 (docs)",
    },
    source: [
      "https://huggingface.co/deepseek-ai/DeepSeek-V3.1/blob/main/README.md",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "Bedrock returned toolUse for DeepSeek V3.2 on 2026-11-08; V3.1 itself was not run",
    ],
  },
  {
    id: "gpt-oss",
    label: "gpt-oss (Harmony)",
    match: [/gpt[-._ ]?oss/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "gpt-oss 20B and 120B: structured 100%, no leak",
    textDialect: "harmony",
    promptStyle: {
      style: "native",
      evidence: "100% structured on Converse (live 2026-11-10)",
    },
    serverParser: { vllm: "openai", basis: "vllm-docs" },
    source: [
      "https://huggingface.co/openai/gpt-oss-120b/blob/main/chat_template.jinja",
      "https://developers.openai.com/cookbook/articles/openai-harmony",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: ["reasoning is the Harmony analysis channel, not a tag pair"],
  },
  {
    id: "gemma-4",
    label: "Gemma 4",
    match: [/gemma[-._ ]?4/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "gemma4",
    promptStyle: {
      style: "native",
      evidence: "Gemma 4 template renders tools natively (read 2026-11-10)",
    },
    serverParser: {
      vllm: "gemma4",
      basis: "registered-only",
      note: "the name is in vLLM's parser registry; its pairing was not read",
    },
    source: [
      "https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja",
    ],
    readOn: READ,
    unverified: ["no recovery parser; the vLLM pairing was not read"],
  },
  {
    id: "gemma-3",
    label: "Gemma 3",
    match: [/gemma[-._ ]?3/],
    bedrockTools: "no",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured: "Gemma 3 27B: 0/8 calls, prose, code and refusals",
    textDialect: "none",
    promptStyle: {
      style: "codeblock",
      evidence:
        "0/8 calls with native tools (live 2026-11-10) and the template renders no tools; codeblock (core/tools/systemMessageTools) is the only existing prompted path and is UNTESTED on Gemma 3",
    },
    source: [
      "https://huggingface.co/unsloth/gemma-3-27b-it/blob/main/chat_template.jinja",
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-4",
    label: "Llama 4 (Scout, Maverick)",
    match: [/llama[-._ ]?4/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "most",
    measured:
      "Llama 4 Maverick: structured 6/8; 2/8 wrote a JSON array whose arguments were wrapped as {type,value} objects (not recoverable)",
    textDialect: "pythonic",
    promptStyle: {
      style: "pythonic",
      evidence:
        "template instructs the [func(arg=v)] form (read 2026-11-10); live Maverick replies were JSON with wrapped values, so the prompted form is not proven",
    },
    observedLeak: "llama-json with wrapped values",
    recoverWith: "pythonic",
    serverParser: {
      vllm: "llama4_pythonic",
      basis: "vllm-docs",
      note: "the docs recommend it over llama3_json for Llama 4, with tool_chat_template_llama4_pythonic.jinja",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-4-Scout-17B-16E-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-3.3",
    label: "Llama 3.3",
    match: [/llama[-._ ]?3[-._ ]?3/],
    bedrockTools: "with-recovery",
    toolsEvidence: "proved",
    nativeOnConverse: "none",
    measured:
      "Llama 3.3 70B: structured 0/8; JSON call in the text 8/8, 6/8 recovered by llama-json (2/8 carry a numeric string for an integer)",
    textDialect: "llama-json",
    promptStyle: {
      style: "llama-json",
      evidence:
        'template instructs {"name","parameters"} (read 2026-11-10); wrote exactly that as text 8/8 live',
    },
    observedLeak: "llama-json",
    recoverWith: "llama-json",
    serverParser: {
      vllm: "llama3_json",
      basis: "vllm-docs",
      note: "with --chat-template examples/tool_chat_template_llama3.1_json.jinja (or the 3.2 template)",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
  },
  {
    id: "llama-3.1-3.2",
    label: "Llama 3.1 and 3.2",
    match: [/llama[-._ ]?3/],
    bedrockTools: "with-recovery",
    toolsEvidence: "inferred",
    nativeOnConverse: "unmeasured",
    textDialect: "llama-json",
    promptStyle: {
      style: "llama-json",
      evidence:
        'Meta 3.1 prompt format and the 3.3 template instruct {"name","parameters"}; not run live',
    },
    recoverWith: "llama-json",
    serverParser: {
      vllm: "llama3_json",
      basis: "vllm-docs",
      note: "Llama 3.2 1B/3B use pythonic with tool_chat_template_llama3.2_pythonic.jinja per the docs",
    },
    source: [
      "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/blob/main/chat_template.jinja",
      VLLM_DOCS,
    ],
    readOn: READ,
    unverified: [
      "not run live; the format is the Llama 3.3 template's and Meta's 3.1 prompt format",
    ],
  },
  {
    id: "mistral",
    label: "Mistral, Mistral Large 3, Devstral, Codestral, Ministral",
    match: [/devstral|mistral|mixtral|ministral|magistral|codestral/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured: "Devstral 2 and Mistral Large 3: structured 100%, no leak",
    textDialect: "mistral",
    promptStyle: {
      style: "native",
      evidence:
        "Devstral 2 and Mistral Large 3: 100% structured on Converse (live 2026-11-10)",
    },
    serverParser: {
      vllm: "mistral",
      basis: "vllm-docs",
      note: "confirmed for Mistral-7B-Instruct-v0.3; recent models use the mistral-common tokenizer mode",
    },
    source: [
      "https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/blob/main/tokenizer_config.json",
      "https://huggingface.co/unsloth/Devstral-Small-2507/blob/main/chat_template.jinja",
      VLLM_DOCS,
      LIVE,
    ],
    readOn: READ,
    unverified: [
      "official Mistral repositories ship a mistral-common encoding that was not read; templates are from mirrors",
    ],
  },
  {
    id: "nova",
    label: "Amazon Nova",
    match: [/amazon\.nova|(?:^|[^a-z])nova[-._ ]?(?:pro|lite|micro|premier|2)/],
    bedrockTools: "yes",
    toolsEvidence: "proved",
    nativeOnConverse: "all",
    measured:
      "Nova Pro and Nova 2 Lite: structured 100% in the run; an earlier failure wrote present_plan(...) as text (ROADMAP H13)",
    textDialect: "pythonic",
    promptStyle: {
      style: "native",
      evidence:
        "100% structured on Converse (live 2026-11-10); pythonic leak seen earlier (ROADMAP H13) is the recoverable form",
    },
    observedLeak: "pythonic",
    recoverWith: "pythonic",
    thinkingTags: ["<thinking>", "</thinking>"],
    // Nova Pro/Lite/Micro/Premier only (seen live 2026-11-08); Nova 2 uses reasoningContent.
    thinkingInText: /nova-(?:pro|lite|micro|premier)/,
    source: [
      "https://docs.aws.amazon.com/nova/latest/userguide/tool-use.html",
      "https://docs.aws.amazon.com/nova/latest/userguide/prompting-tool-troubleshooting.html",
      LIVE,
    ],
    readOn: READ,
    unverified: ["no archived raw reply of the pythonic failure"],
  },
  {
    id: "claude",
    label: "Claude",
    match: [/claude/],
    bedrockTools: "yes",
    toolsEvidence: "inferred",
    nativeOnConverse: "all",
    textDialect: "none",
    promptStyle: {
      style: "native",
      evidence: "Anthropic tool use",
    },
    source: ["plans/model-families-2026-11.md"],
    readOn: READ,
    unverified: [
      "claude-2 and claude-instant have no tools (kept off in toolSupport.ts)",
    ],
  },
  {
    id: "grok",
    label: "Grok",
    match: [/grok/],
    bedrockTools: "unmeasured",
    toolsEvidence: "unmeasured",
    nativeOnConverse: "unmeasured",
    textDialect: "none",
    promptStyle: {
      style: "native",
      evidence:
        "xAI documents an OpenAI-style envelope only; raw format undocumented",
    },
    source: ["https://docs.x.ai/docs/guides/function-calling"],
    readOn: READ,
    unverified: ["the raw text format is not documented"],
  },
];
