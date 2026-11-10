import type { Dialect } from "./toolDialectDetect.js";

/**
 * Golden fixtures for toolDialectDetect. `origin` says how much to trust each:
 * - verbatim: copied from a primary source named in `source`.
 * - template: assembled from the literal strings of the vendor's chat template,
 *   which is what the model was trained to write.
 * - reconstructed: built from a prose description or from memory; the shape is
 *   probably right but no model wrote these exact bytes.
 * Sources were read on 2026-11-10.
 */
export interface Fixture {
  name: string;
  dialect: Dialect;
  text: string;
  origin: "verbatim" | "template" | "reconstructed";
  source: string;
}

export const POSITIVE: Fixture[] = [
  {
    name: "qwen3-coder call",
    dialect: "qwen-xml",
    origin: "template",
    source:
      "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/chat_template.jinja (literals '\\n<tool_call>\\n<function=', '<parameter=', '\\n</parameter>\\n', '</function>\\n</tool_call>')",
    text: "I'll read it.\n\n<tool_call>\n<function=Read>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>",
  },
  {
    name: "qwen3-coder truncated at max_tokens",
    dialect: "qwen-xml",
    origin: "template",
    source: "same template, cut after the first parameter value",
    text: "<tool_call>\n<function=Write>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=content>\nexport const a",
  },
  {
    name: "qwen3-coder two calls, newline value",
    dialect: "qwen-xml",
    origin: "template",
    source: "same template",
    text: "<tool_call>\n<function=probe>\n<parameter=text>\nline1\nline2\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=probe>\n<parameter=text>\nx\n</parameter>\n</function>\n</tool_call>",
  },
  {
    name: "glm-4.5 call",
    dialect: "glm-xml",
    origin: "template",
    source:
      "https://huggingface.co/zai-org/GLM-4.5/raw/main/chat_template.jinja ('\\n<tool_call>' + name, '<arg_key>', '<arg_value>', '</tool_call>')",
    text: "\n<tool_call>Read<arg_key>path</arg_key><arg_value>src/a.ts</arg_value></tool_call>",
  },
  {
    name: "hermes json call",
    dialect: "hermes-json",
    origin: "reconstructed",
    source:
      "Hermes/Qwen2.5 form as in plans/tool-dialect-detection.md; template not re-read this session (unverified)",
    text: '<tool_call>\n{"name": "Read", "arguments": {"path": "src/a.ts"}}\n</tool_call>',
  },
  {
    name: "kimi k2 call",
    dialect: "kimi-tokens",
    origin: "reconstructed",
    source:
      "https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md (section tokens and 'functions.get_weather:0' read; full line assembled by us); token names verbatim from tokenizer_config.json",
    text: '<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|>',
  },
  {
    name: "gpt-oss harmony call",
    dialect: "harmony",
    origin: "verbatim",
    source: "https://github.com/openai/harmony/blob/main/docs/format.md",
    text: '<|channel|>analysis<|message|>Need to use function get_weather.<|end|><|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"location":"San Francisco"}<|call|>',
  },
  {
    name: "deepseek v3.2 dsml marker (leaked before a toolUse block)",
    dialect: "dsml",
    origin: "verbatim",
    source:
      "packages/openai-adapters/src/apis/bedrockHelpers.ts DEEPSEEK_DSML_MARKER, observed on Bedrock",
    text: "Let me check.\n\n<\uFF5CDSML\uFF5Cfunction_calls",
  },
  {
    name: "deepseek v3.2 dsml full call",
    dialect: "dsml",
    origin: "reconstructed",
    source:
      "marker verbatim as above; invoke/parameter shape per vLLM deepseek_v32 parser page (https://docs.vllm.ai/en/latest/api/vllm/parser/deepseek_v32/) as summarised in plans/tool-dialect-detection.md",
    text: '<\uFF5CDSML\uFF5Cfunction_calls>\n<\uFF5CDSML\uFF5Cinvoke name="Read">\n<\uFF5CDSML\uFF5Cparameter name="path" string="true">a.ts</\uFF5CDSML\uFF5Cparameter>\n</\uFF5CDSML\uFF5Cinvoke>\n</\uFF5CDSML\uFF5Cfunction_calls>',
  },
  {
    name: "llama pythonic list",
    dialect: "pythonic",
    origin: "verbatim",
    source:
      "https://docs.vllm.ai/en/latest/features/tool_calling/ (pythonic parser)",
    text: "[get_weather(city='San Francisco', metric='celsius'), get_weather(city='Seattle', metric='celsius')]",
  },
  {
    name: "functiongemma call",
    dialect: "functiongemma",
    origin: "verbatim",
    source: "https://docs.vllm.ai/en/latest/features/tool_calling/",
    text: "<start_function_call>call:get_weather{location:<escape>London<escape>}<end_function_call>",
  },
  {
    name: "mistral tool calls",
    dialect: "mistral",
    origin: "reconstructed",
    source:
      "[TOOL_CALLS] token verbatim from Mistral-7B-Instruct-v0.3 tokenizer_config.json; JSON list body from memory (unverified)",
    text: '[TOOL_CALLS] [{"name": "Read", "arguments": {"path": "a.ts"}, "id": "abc123xyz"}]',
  },
  {
    name: "llama 3.1 function tag",
    dialect: "llama-function-tag",
    origin: "reconstructed",
    source:
      "Llama 3.1 prompt-format page not read (redirect); form from memory (unverified)",
    text: '<function=get_weather>{"city": "Paris"}</function>',
  },
  {
    name: "llama python tag",
    dialect: "llama-python-tag",
    origin: "reconstructed",
    source: "token name from memory of the Llama 3.1 format (unverified)",
    text: '<|python_tag|>brave_search.call(query="weather")<|eom_id|>',
  },
  {
    name: "llama json",
    dialect: "llama-json",
    origin: "reconstructed",
    source:
      "vLLM llama3_json parser summary in the design doc (unverified bytes)",
    text: '{"name": "get_weather", "parameters": {"city": "Paris"}}',
  },
  {
    name: "minimax m2 call",
    dialect: "minimax-xml",
    origin: "reconstructed",
    source:
      "minimax:tool_call tag from the vLLM minimax_m2 page via the design doc; body assembled by us",
    text: '<minimax:tool_call>\n<invoke name="Read">\n<parameter name="path">a.ts</parameter>\n</invoke>\n</minimax:tool_call>',
  },
];

/** Replies that must never classify as a dialect. Written by us. */
export const NEGATIVE: { name: string; text: string }[] = [
  {
    name: "plain answer",
    text: "The function returns the sum of both arguments.",
  },
  {
    name: "explains the qwen tag in backticks",
    text: "Qwen3-Coder writes `<function=Read>` followed by `<parameter=path>` blocks.",
  },
  {
    name: "shows hermes markup in a fence",
    text: 'Example:\n```xml\n<tool_call>\n{"name": "Read", "arguments": {}}\n</tool_call>\n```\nThat is what the template renders.',
  },
  {
    name: "python snippet in a fence",
    text: "Run it like so:\n```python\npresent_plan(title='x', decisions=[])\n```",
  },
  {
    name: "pythonic call buried in prose",
    text: "You could call present_plan(title='x') after the review, then merge.",
  },
  {
    name: "json answer that is not a call",
    text: '{"status": "ok", "items": [1, 2, 3]}',
  },
  { name: "html", text: '<div class="a"><p>hello</p></div>' },
  {
    name: "generics and comparison",
    text: "if (a < b && c > d) { return Array<string>(); }",
  },
  {
    name: "bracketed text",
    text: "[TODO] finish the migration, [note] see PR",
  },
  {
    name: "think tags only",
    text: "<think>I should read the file first.</think>I will read it.",
  },
  {
    name: "shell with angle brackets",
    text: "cat < in.txt > out.txt; echo $((1<2))",
  },
  {
    name: "xml config",
    text: '<function name="x"/> is a Spring-style element',
  },
  { name: "empty", text: "" },
];
