// `suggest`: from results to a profile per model, in the shape of a preset
// table row plus the evidence behind each field. The profile is written to the
// lab's own profiles folder; nothing here touches the product's table.
import path from "node:path";
import { armOf, groupBy, usable } from "./report.mjs";
import { slug, writeText } from "./paths.mjs";
import { wilson } from "./stats.mjs";

const MIN_N = 8;

function armStats(rs) {
  const scored = rs.filter((r) => r.score);
  return {
    ...wilson(scored.filter((r) => r.score.valid).length, scored.length),
  };
}

const tally = (rs, pick) => {
  const m = new Map();
  for (const r of rs) for (const v of pick(r)) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

const nativeClass = (r, n) =>
  n < MIN_N
    ? "unmeasured"
    : r.lo >= 0.8
      ? "all"
      : r.rate >= 0.5
        ? "most"
        : "none";

export function buildProfile(
  model,
  records,
  { product, minN = MIN_N, now = new Date() } = {},
) {
  const rs = usable(
    records.filter((r) => r.model === model && r.kind !== "reviewer"),
  );
  const arms = [...groupBy(rs, armOf)]
    .map(([arm, ars]) => ({
      arm,
      mode: ars[0].mode,
      style: ars[0].style,
      variant: ars[0].variant,
      ...armStats(ars),
    }))
    .filter((a) => a.n > 0)
    .sort((a, b) => b.lo - a.lo || b.rate - a.rate);
  const enough = arms.filter((a) => a.n >= minN);
  const native = arms.filter((a) => a.mode === "native" && !a.variant);
  const text = arms.filter((a) => a.mode === "text" && !a.variant);
  const nativeAll = rs.filter((r) => r.mode === "native" && r.score);
  const nativeRate = wilson(
    nativeAll.filter((r) => r.score.valid).length,
    nativeAll.length,
  );
  const textReplies = rs.filter(
    (r) => r.outcome === "text-call" || r.outcome === "format-broken",
  );
  const leakDialects = tally(
    textReplies.filter((r) => r.mode === "native"),
    (r) =>
      r.detected && !["prose", "unknown"].includes(r.detected)
        ? [r.detected]
        : [],
  );
  const recovers = tally(textReplies, (r) => r.recoveredBy ?? []);
  const bestText = text.filter((a) => a.n >= minN)[0];
  const bestVariant = arms.filter((a) => a.variant && a.n >= minN)[0];
  const preset = product?.presets?.resolve?.(model);
  const date = now.toISOString().slice(0, 10);
  const ev = (a) =>
    `local lab ${date}: ${a.k}/${a.n} valid, 95% CI ${Math.round(a.lo * 100)}-${Math.round(a.hi * 100)}%`;
  const row = {
    id: slug(model).toLowerCase(),
    match: [`^${model.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`],
    nativeToolCalls: nativeClass(nativeRate, nativeAll.length),
    textDialect: leakDialects[0]?.[0] ?? preset?.textDialect ?? null,
    promptStyle: bestText
      ? { style: bestText.style, evidence: ev(bestText) }
      : { style: "native", evidence: "no text-mode arm had enough replies" },
    ...(leakDialects[0] ? { observedLeak: leakDialects[0][0] } : {}),
    ...(recovers[0] ? { recoverWith: recovers[0][0] } : {}),
    readOn: date,
    unverified: [
      "measured on a local Ollama build and quantisation; the hosted model and its template may differ",
      `fewer than ${minN} replies per arm decide nothing`,
    ],
  };
  let comparison = "not enough evidence to compare native and text";
  if (native[0] && bestText && native[0].n >= minN)
    comparison =
      native[0].lo > bestText.hi
        ? "native tools beat asking in text (intervals disjoint)"
        : bestText.lo > native[0].hi
          ? "asking in text beats native tools (intervals disjoint)"
          : "native and text are not separable at this sample size";
  return {
    schema: 1,
    model,
    generatedAt: now.toISOString(),
    records: rs.length,
    presetMatched: preset?.id ?? null,
    native: {
      ...nativeRate,
      structured: rs.filter(
        (r) => r.mode === "native" && r.outcome === "structured",
      ).length,
      leaked: rs.filter(
        (r) =>
          r.mode === "native" &&
          ["text-call", "format-broken"].includes(r.outcome),
      ).length,
    },
    ranking: arms,
    best: enough[0] ?? null,
    bestTextStyle: bestText ?? null,
    bestVariant: bestVariant ?? null,
    comparison,
    leakDialects: leakDialects.map(([dialect, n]) => ({ dialect, n })),
    parsersThatRecovered: recovers.map(([parser, n]) => ({ parser, n })),
    row,
  };
}

/** Write profiles/<model>.json for every model in `records`; returns the paths. */
export function writeProfiles(records, roots, opts = {}) {
  const models = [
    ...new Set(
      records.filter((r) => r.kind !== "reviewer").map((r) => r.model),
    ),
  ];
  return models.map((m) => {
    const p = buildProfile(m, records, opts);
    const file = path.join(roots.profiles, `${slug(m)}.json`);
    writeText(file, JSON.stringify(p, null, 2) + "\n", roots);
    return { model: m, file, profile: p };
  });
}
