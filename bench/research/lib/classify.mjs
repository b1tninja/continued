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
    .filter(([, req]) => req.every((s) => body.includes(s)))
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
