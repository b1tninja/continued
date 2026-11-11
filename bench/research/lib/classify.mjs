// Conservative classifier for the tool-call form a chat template writes.
// Every rule is a set of literal substrings that must ALL be present. Anything
// that is not exactly one known form is "undecided"; the nearest form is never
// picked. See README.md for what this can and cannot say.

export const RULES = {
  "qwen-xml": ["<function=", "<parameter="],
  "glm-xml": ["<arg_key>", "<arg_value>"],
  "toolcall-json": ["<TOOLCALL>"],
  harmony: ["<|channel|>commentary", "functions."],
  "kimi-tokens": ["<|tool_call_begin|>"],
  "minimax-xml": ["<minimax:tool_call>"],
  dsml: ["｜DSML｜"],
  "deepseek-tokens": ["<｜tool▁call▁begin｜>"],
  mistral: ["[TOOL_CALLS]"],
  gemma4: ["<|tool_call>"],
  "llama-json": ['"parameters"', "Respond in the format {"],
  pythonic: ["[func_name1("],
  "hermes-json": ["<tool_call>", '"name"'],
  // Classifier-only verdicts (see NOVEL_FORMS): forms the hold-out found that
  // no preset dialect names. They say which form the template writes and
  // nothing else; no parser exists for any of them.
  "seed-xml": ["<seed:tool_call>", "<function=", "<parameter="],
  "granite-tokens": ["<|tool_call|>"],
  "lfm-tokens": ["<|tool_call_start|>"],
  "longcat-json": ["<longcat_tool_call>"],
  "solar-tokens": ["<|tool_call:begin|>"],
  "olmo-function-calls": ["<function_calls>"],
};

/**
 * Verdicts that are not values of the preset table's TextDialect. A repo whose
 * template gets one of these is "novel" in `check`, never "agree".
 */
export const NOVEL_FORMS = new Set([
  "seed-xml",
  "granite-tokens",
  "lfm-tokens",
  "longcat-json",
  "solar-tokens",
  "olmo-function-calls",
]);

/**
 * Extra patterns a rule needs besides its literals. The Qwen-XML rule accepts
 * `<function=` only when the plain `<tool_call>` tag opens it (allowing the
 * jinja quoting and the escaped newline between them): ByteDance Seed-OSS
 * writes the same inner markup inside `<seed:tool_call>`, which is a different
 * wrapper and so a different form.
 */
const REQUIRES = {
  "qwen-xml": [/<tool_call>(?:\\n|\s|["'+~]|\{\{-?|-?\}\})*<function=/],
};

// `<tool_call>` also wraps the qwen-xml and glm-xml forms, so the generic
// hermes-json rule is dropped when a more specific rule matched too.
const GENERIC = "hermes-json";

export function stripComments(text) {
  return text.replace(/\{#[\s\S]*?#\}/g, "");
}

/** Every literal marker of every rule, for excerpting. */
export const ALL_MARKERS = [...new Set(Object.values(RULES).flat())];

/**
 * @param {string | null | undefined} text  template text, or null when there is none
 * @returns {{outcome: "decided"|"none"|"undecided", dialect: string|null,
 *   reason: string, toolsRendered: boolean, hits: string[]}}
 */
export function classify(text) {
  if (text == null || text === "") {
    return {
      outcome: "undecided",
      dialect: null,
      reason: "no-template",
      toolsRendered: false,
      hits: [],
    };
  }
  const body = stripComments(text);
  const toolsRendered = /\btools\b/.test(body);
  let hits = Object.entries(RULES)
    .filter(
      ([d, req]) =>
        req.every((s) => body.includes(s)) &&
        (REQUIRES[d] ?? []).every((re) => re.test(body)),
    )
    .map(([d]) => d);
  if (hits.length > 1 && hits.includes(GENERIC)) {
    hits = hits.filter((d) => d !== GENERIC);
  }
  if (hits.length === 1) {
    return {
      outcome: "decided",
      dialect: hits[0],
      reason: toolsRendered
        ? "one rule matched"
        : "one rule matched; tools list not rendered (history writer only)",
      toolsRendered,
      hits,
    };
  }
  if (hits.length === 0) {
    return toolsRendered
      ? {
          outcome: "undecided",
          dialect: null,
          reason: "tools-rendered-no-known-marker",
          toolsRendered,
          hits,
        }
      : {
          outcome: "none",
          dialect: "none",
          reason: "no tools in template",
          toolsRendered,
          hits,
        };
  }
  return {
    outcome: "undecided",
    dialect: null,
    reason: "multiple",
    toolsRendered,
    hits,
  };
}
