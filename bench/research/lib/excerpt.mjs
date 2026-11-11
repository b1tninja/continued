import { createHash } from "node:crypto";
import { ALL_MARKERS, stripComments } from "./classify.mjs";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Up to `max` chars around the first marker (or the first `tools`), never the whole file. */
export function excerpt(text, max = 1200) {
  const body = stripComments(text);
  let at = -1;
  for (const m of ALL_MARKERS) {
    const i = body.indexOf(m);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = Math.max(0, body.search(/\btools\b/));
  const start = Math.max(0, at - Math.floor(max / 3));
  return body.slice(start, start + max);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A reduced template for test fixtures: the template is cut into segments at
 * each jinja tag, and only a 120-character window around each marker or
 * `tools` is kept (at most 60 segments). The classifier reaches the same
 * verdict on it as on the whole file, and it is not a redistribution of the
 * vendor's template.
 */
export function reduce(text) {
  const needles = [...ALL_MARKERS.map(escapeRe), "\\btools\\b"];
  const re = new RegExp(needles.join("|"), "g");
  const out = [];
  for (const seg of stripComments(text).split(/(?=\{[%{])/)) {
    const spans = [...seg.matchAll(re)].map((m) => [
      Math.max(0, m.index - 60),
      m.index + m[0].length + 60,
    ]);
    if (spans.length === 0) continue;
    const merged = [spans[0]];
    for (const [a, b] of spans.slice(1)) {
      const last = merged[merged.length - 1];
      if (a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    out.push(
      merged
        .map(([a, b]) => seg.slice(a, b).replace(/\n/g, "\\n"))
        .join(" ... "),
    );
  }
  return out.slice(0, 60).join("\n") + "\n";
}
