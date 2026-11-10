/**
 * Detecting which tool-call dialect a model speaks when its id does not say.
 * Pure functions: nothing here sends a request or reads a file. The design and
 * the sources for every fingerprint are in plans/tool-dialect-detection.md.
 */

export type Dialect =
  | "qwen-xml" // <tool_call><function=NAME><parameter=KEY>v</parameter></function></tool_call>
  | "hermes-json" // <tool_call>{"name":..,"arguments":{..}}</tool_call>
  | "glm-xml" // <tool_call>NAME<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
  | "dsml" // DeepSeek V3.2 fullwidth-bar function_calls / invoke / parameter
  | "kimi-tokens" // <|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>{json}
  | "harmony" // <|channel|>commentary to=functions.NAME <|constrain|>json<|message|>{json}<|call|>
  | "llama-function-tag" // Llama 3.1: <function=NAME>{json}</function>
  | "llama-python-tag" // <|python_tag|>
  | "llama-json" // bare {"name":..,"parameters":{..}}
  | "mistral" // [TOOL_CALLS][{"name":..,"arguments":..}]
  | "minimax-xml" // <minimax:tool_call><invoke name=..>
  | "functiongemma" // <start_function_call>call:NAME{k:<escape>v<escape>}<end_function_call>
  | "pythonic"; // [name(arg=1), other(arg="x")]

export type DetectKind = Dialect | "native-structured" | "prose" | "unknown";

export type ThinkingConvention =
  "think-tags" | "thinking-tags" | "harmony-analysis" | "none";

export interface ToolCallLike {
  id?: string;
  name: string;
  /** The raw argument string as the server returned it. */
  arguments: string;
}

export interface ToolReply {
  content: string | null | undefined;
  toolCalls?: ToolCallLike[];
  /** Names of the tools that were offered; makes pythonic detection safer. */
  knownTools?: string[];
}

export interface Classification {
  dialect: DetectKind;
  /** 0..1. How sure we are that `dialect` is what this reply shows. */
  confidence: number;
  evidence: string[];
  thinking: ThinkingConvention;
}

/* Confidence thresholds, shared by classification consumers and decideDialect. */

/** Act on a result: recover calls from text, or trust a native pipeline. */
export const ACCEPT_THRESHOLD = 0.8;
/** Worth a prompt hint or a log line, never enough to rewrite a reply. */
export const ADVISORY_THRESHOLD = 0.5;
/** Two families closer than this (both advisory or better) is a conflict. */
export const CONFLICT_MARGIN = 0.2;
/** How much each kind of evidence is trusted, as a multiplier on its own score. */
export const SOURCE_WEIGHT = {
  table: 0.85, // a name we recognise; custom fine-tunes break it
  metadata: 0.9, // the chat template says what the model was trained on, not what the server parses
  probe: 1.0, // observed on this endpoint, this model, today
  leak: 1.0, // observed in real use
} as const;
/** Suggested lifetime of a probe result in a per-endpoint cache. */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

const FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const NAME = String.raw`[A-Za-z_][\w.\-]*`;
const BAR = "｜"; // fullwidth vertical line used by DeepSeek tokens

interface Fingerprint {
  dialect: Dialect;
  strong: RegExp;
  weak?: RegExp;
  label: string;
}

/**
 * Ordered most specific first. `strong` is an opening marker followed by the
 * shape only that family writes; `weak` is a marker that other families share.
 */
const FINGERPRINTS: Fingerprint[] = [
  {
    dialect: "dsml",
    strong: new RegExp(
      `<[${BAR}|]DSML[${BAR}|](?:function_calls|tool_calls|invoke)`,
    ),
    label: "DSML marker",
  },
  {
    dialect: "kimi-tokens",
    strong: new RegExp(
      String.raw`<\|tool_calls?_section_begin\|>|<\|tool_call_begin\|>\s*functions\.${NAME}:\d+`,
    ),
    weak: /<\|tool_call_(?:begin|argument_begin|end)\|>/,
    label: "Kimi tool-call tokens",
  },
  {
    dialect: "harmony",
    strong: new RegExp(
      String.raw`to=functions\.${NAME}\s*(?:<\|constrain\|>|<\|message\|>)|<\|channel\|>commentary\s+to=`,
    ),
    weak: /<\|call\|>|<\|channel\|>(?:analysis|commentary|final)/,
    label: "Harmony channel/recipient",
  },
  {
    dialect: "minimax-xml",
    strong: /<minimax:tool_call>/,
    label: "<minimax:tool_call>",
  },
  {
    dialect: "functiongemma",
    strong: /<start_function_call>\s*call:/,
    label: "<start_function_call>call:",
  },
  {
    dialect: "llama-python-tag",
    strong: /<\|python_tag\|>/,
    label: "<|python_tag|>",
  },
  {
    dialect: "mistral",
    strong: /\[TOOL_CALLS\]\s*[\[{]/,
    weak: /\[TOOL_CALLS\]/,
    label: "[TOOL_CALLS]",
  },
  {
    // Qwen3-Coder: function tag followed by a parameter tag or an immediate close.
    dialect: "qwen-xml",
    strong: new RegExp(
      String.raw`<function=${NAME}>\s*(?:<parameter=|</function>)|<parameter=${NAME}>`,
    ),
    weak: /<function=[\w.\-]+>/,
    label: "<function=..><parameter=..>",
  },
  {
    // Llama 3.1 custom tool form: the function tag wraps JSON directly.
    dialect: "llama-function-tag",
    strong: new RegExp(String.raw`<function=${NAME}>\s*\{`),
    label: "<function=NAME>{json}",
  },
  {
    dialect: "glm-xml",
    strong: new RegExp(
      String.raw`<tool_call>\s*${NAME}\s*<arg_key>|<arg_key>[^<]*</arg_key>\s*<arg_value>`,
    ),
    label: "<arg_key>/<arg_value>",
  },
  {
    dialect: "hermes-json",
    strong: /<tool_call>\s*\{\s*"name"\s*:/,
    weak: /<tool_call>/,
    label: '<tool_call>{"name"',
  },
];

function stripCode(text: string): { outside: string; fenced: string } {
  const fenced: string[] = [];
  const outside = text
    .replace(FENCE, (m) => {
      fenced.push(m);
      return "\n";
    })
    .replace(INLINE_CODE, " ");
  return { outside, fenced: fenced.join("\n") };
}

function thinkingOf(text: string): ThinkingConvention {
  if (/<think>|<\/think>/.test(text)) return "think-tags";
  if (/<thinking>|<\/thinking>/.test(text)) return "thinking-tags";
  if (/<\|channel\|>analysis/.test(text)) return "harmony-analysis";
  return "none";
}

function scan(
  text: string,
): { dialect: Dialect; confidence: number; label: string } | undefined {
  for (const f of FINGERPRINTS) {
    if (f.strong.test(text)) {
      // Opening and closing markers both present means a finished call.
      const closed =
        /<\/function>|<\/tool_call>|<\/invoke>|<\|call\|>|<\|tool_call_end\|>|<end_function_call>|<\/minimax:tool_call>|<\/arg_value>/.test(
          text,
        );
      return {
        dialect: f.dialect,
        confidence: closed ? 0.97 : 0.88, // 0.88 still accepts a truncated call
        label: f.label + (closed ? " with closing marker" : " (unclosed)"),
      };
    }
  }
  for (const f of FINGERPRINTS) {
    if (f.weak?.test(text)) {
      return {
        dialect: f.dialect,
        confidence: 0.6,
        label: `${f.label} alone`,
      };
    }
  }
  return undefined;
}

function pythonicCall(
  text: string,
  known: string[] | undefined,
): { name: string; confidence: number } | undefined {
  const t = text.trim();
  const m = new RegExp(
    String.raw`^\[?\s*(${NAME})\(\s*(?:${NAME}\s*=|\)|["'\d\[{])[\s\S]*\)\s*\]?$`,
  ).exec(t);
  if (!m || /\n\s*\n/.test(t)) return undefined; // the whole reply, one block
  const known_ = known?.includes(m[1]) ?? false;
  return { name: m[1], confidence: known_ ? 0.9 : 0.45 };
}

function bareJsonCall(
  text: string,
): { key: "parameters" | "arguments" } | undefined {
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return undefined;
  try {
    const o = JSON.parse(t);
    if (typeof o?.name !== "string") return undefined;
    if ("parameters" in o) return { key: "parameters" };
    if ("arguments" in o) return { key: "arguments" };
  } catch {
    /* not JSON */
  }
  return undefined;
}

function argsAreJson(calls: ToolCallLike[]): boolean {
  return calls.every((c) => {
    if (c.arguments === "") return true;
    try {
      const v = JSON.parse(c.arguments);
      return typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  });
}

/**
 * Classify one assistant reply. Structured tool calls win: if the server
 * returned them it parsed the model's markup, whatever the dialect was. Markup
 * in the content alone means the server did not. Markup quoted inside a code
 * fence or inline code is a mention, not a call, and never classifies as a
 * dialect.
 */
export function classifyToolReply(reply: ToolReply): Classification {
  const content = reply.content ?? "";
  const thinking = thinkingOf(content);
  const evidence: string[] = [];
  const calls = reply.toolCalls ?? [];

  if (calls.length > 0) {
    evidence.push(`${calls.length} structured tool_call(s)`);
    let confidence = 0.95;
    if (!argsAreJson(calls)) {
      evidence.push("arguments are not a JSON object");
      confidence = 0.6;
    }
    const known = reply.knownTools;
    if (known && calls.some((c) => !known.includes(c.name))) {
      evidence.push("a call names a tool that was not offered");
      confidence = Math.min(confidence, 0.6);
    }
    const { outside } = stripCode(content);
    const stray = scan(outside);
    if (stray && stray.confidence >= ACCEPT_THRESHOLD) {
      evidence.push(`markup also left in content: ${stray.label}`);
      confidence = Math.min(confidence, 0.7);
    }
    return { dialect: "native-structured", confidence, evidence, thinking };
  }

  const { outside, fenced } = stripCode(content);
  const hit = scan(outside);
  if (hit) {
    evidence.push(`content has ${hit.label}`);
    return {
      dialect: hit.dialect,
      confidence: hit.confidence,
      evidence,
      thinking,
    };
  }

  const bare = bareJsonCall(outside);
  if (bare) {
    evidence.push(`whole reply is a JSON object with name and ${bare.key}`);
    return {
      dialect: bare.key === "parameters" ? "llama-json" : "hermes-json",
      confidence: 0.7,
      evidence,
      thinking,
    };
  }

  const py = pythonicCall(outside, reply.knownTools);
  if (py) {
    evidence.push(
      `whole reply is a call expression ${py.name}(...)` +
        (py.confidence >= ACCEPT_THRESHOLD
          ? ", name is an offered tool"
          : ", name not among offered tools"),
    );
    return {
      dialect: "pythonic",
      confidence: py.confidence,
      evidence,
      thinking,
    };
  }

  if (fenced && scan(fenced)) {
    evidence.push("markup appears only inside a code fence: a mention");
  }
  if (outside.trim() === "") {
    evidence.push("empty content and no tool calls");
    return { dialect: "unknown", confidence: 0.5, evidence, thinking };
  }
  evidence.push("no tool-call markup and no structured calls");
  return { dialect: "prose", confidence: 0.8, evidence, thinking };
}

/**
 * Guess a dialect from a chat template (llama.cpp /props `chat_template`,
 * Ollama /api/show `template`, a tokenizer_config.json `chat_template`).
 * The template says what the model was trained to write; it does not say which
 * parser the server runs.
 */
export function dialectFromChatTemplate(
  template: string | null | undefined,
): { dialect: Dialect; confidence: number; evidence: string } | undefined {
  if (!template) return undefined;
  const t = template;
  const rules: [Dialect, RegExp, string][] = [
    ["dsml", /DSML/, "DSML in template"],
    ["kimi-tokens", /tool_calls_section_begin/, "Kimi section token"],
    ["harmony", /<\|channel\|>[\s\S]*to=functions|<\|constrain\|>/, "Harmony"],
    ["minimax-xml", /minimax:tool_call/, "minimax tag"],
    ["functiongemma", /start_function_call/, "start_function_call"],
    ["llama-python-tag", /<\|python_tag\|>/, "python_tag"],
    ["mistral", /\[TOOL_CALLS\]/, "[TOOL_CALLS]"],
    ["glm-xml", /<arg_key>/, "<arg_key>"],
    ["qwen-xml", /<function=[\s\S]*<parameter=/, "<function=/<parameter="],
    ["llama-function-tag", /<function=/, "<function= without <parameter="],
    ["hermes-json", /<tool_call>/, "<tool_call> without function tag"],
  ];
  for (const [dialect, re, evidence] of rules) {
    if (re.test(t)) return { dialect, confidence: 0.9, evidence };
  }
  return undefined;
}

/* ---------------------------------------------------------------- probe */

export const PROBE_TOOL_NAME = "dialect_probe_echo";

export interface ProbeRequest {
  messages: { role: "system" | "user"; content: string }[];
  tools: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }[];
  params: { temperature: 0; max_tokens: number; tool_choice: "auto" };
  /** The two calls a faithful reply makes, for verifyProbeCalls. */
  expected: { name: string; arguments: { text: string; count: number } }[];
}

/** The strings the probe asks the model to copy: a quote, a newline, unicode. */
export const PROBE_TEXTS = ['say "hi"', "line1\nline2", "café ☃"];

/**
 * The probe: one harmless made-up tool, two calls asked for at once, one
 * argument that needs escaping. Nothing in it touches the user's files or
 * tools; the caller sends it with no real tool registered and never runs the
 * calls. Not sent by this module.
 */
export function probeRequestFor(): ProbeRequest {
  const expected = [
    { name: PROBE_TOOL_NAME, arguments: { text: PROBE_TEXTS[0], count: 1 } },
    { name: PROBE_TOOL_NAME, arguments: { text: PROBE_TEXTS[1], count: 2 } },
  ];
  return {
    messages: [
      {
        role: "system",
        content:
          "You are a connectivity check. Use the provided tool when asked. Do not explain.",
      },
      {
        role: "user",
        content:
          `Call ${PROBE_TOOL_NAME} twice in the same turn. ` +
          `First call: text is exactly the 8 characters ${JSON.stringify(PROBE_TEXTS[0])}, count 1. ` +
          `Second call: text is exactly "line1", a newline character, then "line2", count 2. ` +
          "Make both calls now and write nothing else.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: PROBE_TOOL_NAME,
          description: "Echoes its arguments. Has no effect.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to echo." },
              count: { type: "integer", description: "A small number." },
            },
            required: ["text", "count"],
          },
        },
      },
    ],
    params: { temperature: 0, max_tokens: 400, tool_choice: "auto" },
    expected,
  };
}

export interface ProbeIntegrity {
  parallel: boolean;
  argumentsIntact: boolean;
  idsPresent: boolean;
  issues: string[];
}

/** Compare structured calls from a probe reply with what was asked for. */
export function verifyProbeCalls(
  calls: ToolCallLike[],
  expected = probeRequestFor().expected,
): ProbeIntegrity {
  const issues: string[] = [];
  const parallel = calls.length >= expected.length;
  if (!parallel) issues.push(`got ${calls.length} call(s), expected 2`);
  let argumentsIntact = calls.length > 0;
  calls.forEach((c, i) => {
    const want = expected[i];
    if (!want) return;
    let got: unknown;
    try {
      got = JSON.parse(c.arguments);
    } catch {
      argumentsIntact = false;
      issues.push(`call ${i}: arguments are not valid JSON`);
      return;
    }
    const g = got as { text?: unknown; count?: unknown };
    if (c.name !== want.name) {
      argumentsIntact = false;
      issues.push(`call ${i}: name ${c.name}`);
    }
    if (g.text !== want.arguments.text) {
      argumentsIntact = false;
      issues.push(`call ${i}: text differs (escaping or unicode lost)`);
    }
    if (g.count !== want.arguments.count) {
      argumentsIntact = false;
      issues.push(`call ${i}: count is ${JSON.stringify(g.count)}`);
    }
  });
  const idsPresent = calls.every((c) => !!c.id);
  if (!idsPresent) issues.push("a call has no id");
  return { parallel, argumentsIntact, idsPresent, issues };
}

/* --------------------------------------------------------------- decision */

export interface DialectSignal {
  dialect: Dialect;
  /** 0..1, how sure the source is. Defaults to 1 for a table entry. */
  confidence?: number;
}

export interface DecideInput {
  /** From the model id or a config override; undefined for an unknown name. */
  table?: DialectSignal;
  /** From server metadata (template sniffing, architecture). */
  metadata?: DialectSignal;
  /** The classification of a probe reply. */
  probe?: Classification;
  /** Classifications of real replies seen in use, newest last. */
  leaks?: Classification[];
}

export type Transport = "native" | "recover" | "render" | "default";

export interface Decision {
  /** The family, or null when nothing is known. */
  dialect: Dialect | null;
  /**
   * native: the server returns structured calls, send tools as today.
   * recover: the server leaves markup in content, parse it client side.
   * render: no native pipeline observed, render tools in text in the family's form.
   * default: not enough evidence; behave as today.
   */
  mode: Transport;
  confidence: number;
  /** accept: act on it. advisory: hint or log only. none: ignore. */
  level: "accept" | "advisory" | "none";
  conflict: boolean;
  reasons: string[];
}

function noisyOr(scores: number[]): number {
  return 1 - scores.reduce((p, s) => p * (1 - s), 1);
}

/**
 * Combine the signals. Two separate questions are answered separately:
 * the family (what the model writes) from every source, noisy-OR combined; and
 * the transport (does the server parse it) from observation only, because a
 * table or a template cannot know the server's parser flags.
 */
export function decideDialect(input: DecideInput): Decision {
  const reasons: string[] = [];
  const family = new Map<Dialect, number[]>();
  const add = (d: Dialect, score: number) =>
    family.set(d, [...(family.get(d) ?? []), score]);

  if (input.table) {
    add(
      input.table.dialect,
      (input.table.confidence ?? 1) * SOURCE_WEIGHT.table,
    );
    reasons.push(`table: ${input.table.dialect}`);
  }
  if (input.metadata) {
    add(
      input.metadata.dialect,
      (input.metadata.confidence ?? 0.9) * SOURCE_WEIGHT.metadata,
    );
    reasons.push(`metadata: ${input.metadata.dialect}`);
  }

  const observed: { c: Classification; weight: number; src: string }[] = [];
  if (input.probe)
    observed.push({
      c: input.probe,
      weight: SOURCE_WEIGHT.probe,
      src: "probe",
    });
  for (const c of input.leaks ?? [])
    observed.push({ c, weight: SOURCE_WEIGHT.leak, src: "live" });

  const seen = new Map<Dialect, number>(); // families actually observed in output
  let native = 0;
  let markup = 0;
  let prose = 0;
  for (const { c, weight, src } of observed) {
    const s = c.confidence * weight;
    if (c.dialect === "native-structured") {
      native = Math.max(native, s);
    } else if (c.dialect === "prose" || c.dialect === "unknown") {
      if (c.dialect === "prose") prose = Math.max(prose, s);
    } else {
      add(c.dialect, s);
      markup = Math.max(markup, s);
      if (s > (seen.get(c.dialect) ?? 0)) seen.set(c.dialect, s);
    }
    reasons.push(`${src}: ${c.dialect} (${c.confidence.toFixed(2)})`);
  }

  // Rank families.
  const ranked = [...family.entries()]
    .map(([d, s]) => [d, noisyOr(s)] as const)
    .sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  // A family seen in real output outranks any guess from a name or template.
  const seenTop = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  const decisive = !!seenTop && seenTop[1] >= ACCEPT_THRESHOLD;
  const conflict =
    !decisive &&
    !!top &&
    !!second &&
    second[1] >= ADVISORY_THRESHOLD &&
    top[1] - second[1] < CONFLICT_MARGIN;
  if (conflict) reasons.push(`conflict: ${top[0]} vs ${second[0]}`);

  // Transport: live markup beats a clean probe, because the server failed once.
  let mode: Transport = "default";
  let transportScore = 0;
  if (markup >= ACCEPT_THRESHOLD) {
    mode = "recover";
    transportScore = markup;
  } else if (native >= ACCEPT_THRESHOLD) {
    mode = "native";
    transportScore = native;
  } else if (prose >= ACCEPT_THRESHOLD) {
    mode = "render";
    transportScore = prose;
  }

  const pick = decisive
    ? ([seenTop[0], noisyOr(family.get(seenTop[0])!)] as const)
    : top;
  const familyScore = !pick || conflict ? 0 : pick[1];
  const dialect =
    !pick || conflict || familyScore < ADVISORY_THRESHOLD ? null : pick[0];

  // recover and render need a family to act on; without one fall back.
  if (
    (mode === "recover" || mode === "render") &&
    familyScore < ACCEPT_THRESHOLD
  ) {
    reasons.push(`${mode} needs a family at ${ACCEPT_THRESHOLD}; falling back`);
    mode = "default";
    transportScore = 0;
  }

  const confidence =
    mode === "default"
      ? familyScore
      : mode === "native"
        ? Math.max(transportScore, familyScore)
        : Math.min(transportScore, familyScore);
  const level =
    mode !== "default" && confidence >= ACCEPT_THRESHOLD
      ? "accept"
      : confidence >= ADVISORY_THRESHOLD
        ? "advisory"
        : "none";
  if (mode === "default") reasons.push("unsure: behave as today");
  return { dialect, mode, confidence, level, conflict, reasons };
}
