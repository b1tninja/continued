// What a reply was, and what it is worth. Two steps:
//   classifyReply  structured | text-call | format-broken | refused | prose
//   scoreReply     did it do what the case asked (valid, schema, false call)
// The leak detector and the recovery parsers are the product's, reached
// through the adapter; the codeblock and TOOLCALL parsers are the lab's own
// because the product has none for them as one-shot parsers.

const parseObj = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** ```tool blocks: TOOL_NAME: x / BEGIN_ARG: k / <json> / END_ARG. */
export function parseCodeblock(text) {
  const calls = [];
  const re = /```tool\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const name = /TOOL_NAME:\s*([^\n]+)/.exec(m[1])?.[1]?.trim();
    if (!name) continue;
    const args = {};
    const argRe = /BEGIN_ARG:\s*([^\n]+)\n([\s\S]*?)\n?END_ARG/g;
    let a;
    while ((a = argRe.exec(m[1]))) {
      const raw = a[2].trim();
      try {
        args[a[1].trim()] = JSON.parse(raw);
      } catch {
        args[a[1].trim()] = raw;
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls.length ? calls : undefined;
}

/** <TOOLCALL>[{"name":..,"arguments":{..}}]</TOOLCALL>. */
export function parseToolcallJson(text) {
  const m = /<TOOLCALL>\s*([\s\S]*?)\s*<\/TOOLCALL>/.exec(text);
  if (!m) return undefined;
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return undefined;
  }
  const list = (Array.isArray(v) ? v : [v]).filter(
    (c) => c && typeof c.name === "string",
  );
  return list.length
    ? list.map((c) => ({
        name: c.name,
        arguments: c.arguments ?? c.parameters ?? {},
      }))
    : undefined;
}

const MARKUP =
  /<tool_call|<function=|<\/?TOOLCALL>|TOOL_NAME:|```tool\b|<\|tool_call|\[TOOL_CALLS\]|<arg_key>|<\|python_tag\|>|"name"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters)"/;
const REFUSAL =
  /\b(i (?:cannot|can't|can not|am unable|am not able|won't)|i'm (?:unable|not able|sorry)|sorry,|unable to (?:access|comply|help)|i do not have (?:access|the ability))\b/i;

/** Run every recovery parser the lab knows over `text`. */
export function recoverAll(text, tools, product) {
  const dialectTools = tools.map((t) => ({
    name: t.name,
    parameters: t.parameters,
  }));
  const out = {};
  for (const [d, fn] of Object.entries(product?.parsers ?? {})) {
    const calls = fn(text, dialectTools);
    if (calls) out[d] = calls;
  }
  const cb = parseCodeblock(text);
  if (cb) out.codeblock = cb;
  const tc = parseToolcallJson(text);
  if (tc) out["toolcall-json"] = tc;
  return out;
}

/**
 * @param reply   {text, toolCalls:[{name, arguments}], ...} as the client returns it
 * @param tools   the wire tools in play ({name, parameters}); may be empty
 * @param product the adapter's product object (detector and parsers), or null parts
 * @param prefer  a dialect to prefer when several parsers recover the text
 */
export function classifyReply(reply, tools, product, prefer) {
  const base = {
    detected: null,
    confidence: 0,
    recoveredBy: [],
    recovered: {},
    calls: [],
  };
  const known = tools.map((t) => t.name);
  if (reply.toolCalls?.length) {
    const calls = reply.toolCalls.map((c) => ({
      name: c.name,
      arguments: parseObj(c.arguments),
    }));
    const bad = calls.some((c) => !c.arguments || !c.name);
    return {
      ...base,
      outcome: bad ? "format-broken" : "structured",
      detected: "native-structured",
      calls,
      note: bad ? "arguments are not a JSON object" : undefined,
    };
  }
  const text = reply.text ?? "";
  const det = product?.detect?.classifyToolReply?.({
    content: text,
    toolCalls: [],
    knownTools: known,
  });
  const recovered = recoverAll(text, tools, product);
  const by = Object.keys(recovered);
  const detected = det?.dialect ?? null;
  if (by.length > 0) {
    const pick = prefer && recovered[prefer] ? prefer : by[0];
    return {
      ...base,
      outcome: "text-call",
      detected,
      confidence: det?.confidence ?? 0,
      recovered,
      recoveredBy: by,
      calls: recovered[pick],
    };
  }
  const leak =
    det &&
    !["prose", "unknown", "native-structured"].includes(det.dialect) &&
    det.confidence >= (product.detect.ADVISORY_THRESHOLD ?? 0.5);
  if (
    leak ||
    MARKUP.test(
      text.replace(/```[\s\S]*?```/g, (b) => (/^```tool\b/.test(b) ? b : "")),
    )
  )
    return {
      ...base,
      outcome: "format-broken",
      detected,
      confidence: det?.confidence ?? 0,
      note: "tool markup the parsers could not read",
    };
  if (REFUSAL.test(text))
    return {
      ...base,
      outcome: "refused",
      detected,
      confidence: det?.confidence ?? 0,
    };
  return {
    ...base,
    outcome: "prose",
    detected,
    confidence: det?.confidence ?? 0,
    note: text.trim() ? undefined : "empty reply",
  };
}

const TYPE_OK = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v && typeof v === "object" && !Array.isArray(v),
};

/** Required keys present and every declared property of its declared type. */
export function schemaFit(args, params) {
  if (!args || typeof args !== "object") return false;
  for (const k of params?.required ?? []) if (!(k in args)) return false;
  for (const [k, v] of Object.entries(args)) {
    const t = params?.properties?.[k]?.type;
    if (t && TYPE_OK[t] && !TYPE_OK[t](v)) return false;
  }
  return true;
}

function argsMatch(args, checks = {}) {
  for (const [k, want] of Object.entries(checks)) {
    const got = args?.[k];
    if (want && typeof want === "object" && "includes" in want) {
      if (typeof got !== "string" || !got.includes(want.includes)) return false;
    } else if (JSON.stringify(got) !== JSON.stringify(want)) return false;
  }
  return true;
}

/**
 * Scores against `expect`:
 *   {tool, args?}        one call to `tool` whose args match
 *   {calls:[{tool,args}]} every listed call present (parallel)
 *   {none:true}          no call at all; any call is a false call
 *   {review:...}         handled by the reviewer suite, not here
 */
export function scoreReply(cls, expect, tools) {
  const calls = cls.calls ?? [];
  const byName = (n) => tools.find((t) => t.name === n);
  const any = calls.length > 0;
  if (expect?.none)
    return {
      valid: !any,
      falseCall: any,
      callValid: !any,
      schemaValid: true,
      argsOk: true,
      calls: calls.length,
    };
  const wanted =
    expect?.calls ??
    (expect?.tool ? [{ tool: expect.tool, args: expect.args }] : []);
  let callValid = wanted.length > 0;
  let schemaValid = any;
  let argsOk = true;
  const used = new Set();
  for (const w of wanted) {
    const named = calls.filter((c) => c.name === w.tool && !used.has(c));
    const hit = named.find((c) => argsMatch(c.arguments, w.args)) ?? named[0];
    if (hit) used.add(hit);
    if (!hit) {
      callValid = false;
      argsOk = false;
      continue;
    }
    if (!schemaFit(hit.arguments, byName(hit.name)?.parameters))
      schemaValid = false;
    if (!argsMatch(hit.arguments, w.args)) argsOk = false;
  }
  if (!any) schemaValid = false;
  return {
    valid: callValid && schemaValid && argsOk,
    falseCall: false,
    callValid,
    schemaValid,
    argsOk,
    calls: calls.length,
  };
}
