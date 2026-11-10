#!/usr/bin/env node
// Reports row ids that plans/*.md use with a scope that disagrees with
// plans/ROADMAP.md, or ids ROADMAP does not have. Standard library only.
// Usage: node scripts/ci/roadmap-ids.js [--strict] [plansDir]
// Exit code is 0 unless --strict is given and findings exist.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ID = String.raw`(?:VA|[A-Z])\d{1,2}[a-z]?`;
const NL = /\r?\n/;
const STOP = new Set(
  (
    "this that with from have into when then than they their there which where while about after before " +
    "only also each other some such must should does done more most less same both being used uses using " +
    "per and the for are not but can its our out any all new one two three first second"
  ).split(" "),
);

function tokens(text) {
  const out = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) || []) {
    const t = w.replace(/[.-]+$/, "");
    if (t.length >= 4 && !STOP.has(t)) out.add(t.replace(/s$/, ""));
  }
  return out;
}

function splitRow(line) {
  // cells of a markdown table row, ignoring pipes inside backticks
  const cells = [];
  let cur = "";
  let tick = false;
  for (const ch of line.trim().replace(/^\||\|$/g, "")) {
    if (ch === "`") tick = !tick;
    if (ch === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const CELL_ID = new RegExp(String.raw`^\*{0,2}(${ID})\*{0,2}$`);
const ROW_START = new RegExp(String.raw`^\|\s*\*{0,2}${ID}\b`);
const BARE_ID = new RegExp(String.raw`(?<![\w/\x60.-])(${ID})(?![\w-])`, "g");
const ROW_REF = new RegExp(String.raw`\b[Rr]ows?\s+\x60?(${ID})\b`, "g");

/** Table rows whose first cell is a bare row id: [{id, scope, line}]. */
function tableRows(text) {
  const rows = [];
  text.split(NL).forEach((line, i) => {
    if (!line.startsWith("|")) return;
    const c = splitRow(line);
    const m = CELL_ID.exec(c[0] || "");
    if (m && c[1]) rows.push({ id: m[1], scope: c[1], line: i + 1 });
  });
  return rows;
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Roadmap map id -> scope text (first definition wins). */
function parseRoadmap(text) {
  const map = new Map();
  for (const r of tableRows(text)) if (!map.has(r.id)) map.set(r.id, r.scope);
  return map;
}

function matches(scope, roadmapScope) {
  const a = tokens(scope);
  const b = tokens(roadmapScope);
  const n = overlap(a, b);
  // conservative: a match is two shared keywords, or one when a side is tiny
  return n >= 2 || (n >= 1 && Math.min(a.size, b.size) <= 3);
}

/** A row's scope. A bare id such as C11 also names its lettered rows C11a, C11b,
 * and a lettered slice such as W6a names a part of row W6. */
function lookup(roadmap, id) {
  if (roadmap.has(id)) return roadmap.get(id);
  if (/[a-z]$/.test(id) && roadmap.has(id.slice(0, -1)))
    return roadmap.get(id.slice(0, -1));
  const parts = [...roadmap].filter(
    ([k]) => k.length === id.length + 1 && k.startsWith(id),
  );
  return parts.length ? parts.map(([, v]) => v).join(" ") : undefined;
}

/** Track letters per plan file, from the "Plan:" lines under each Track heading. */
function planTracks(roadmapText) {
  const map = new Map();
  let track = null;
  for (const line of roadmapText.split(NL)) {
    const h = /^### Track ([A-Z]):/.exec(line);
    if (h) track = h[1];
    else if (/^## /.test(line)) track = null;
    else if (track && /^Plans?:/.test(line)) {
      for (const m of line.matchAll(/`([a-z0-9-]+\.md)`/g)) {
        if (!map.has(m[1])) map.set(m[1], new Set());
        map.get(m[1]).add(track);
      }
    }
  }
  return map;
}

/** Track letter of a row id: VA is Track V's second series. */
function trackOf(id) {
  return id.startsWith("VA") ? "V" : id[0];
}

/**
 * Findings for one plan. `tracks` are the Track letters the plan owns (from
 * ROADMAP's "Plan:" lines plus "Track X" in its first lines). Plans keep local
 * id series too (decisions D1, phases P1, failure modes F1), so only a row id
 * of an owned track is checked as a definition or a bare mention; any other id
 * is checked only when written as "row ID" or "rows ID".
 *  drift:   a plan table row has this id with a scope ROADMAP's row lacks
 *  unlisted: a plan table row whose id ROADMAP does not have yet (a proposal)
 *  missing: a mention of an owned-track id that ROADMAP does not have
 *  prose:   a mention whose line shares no keyword with ROADMAP's row
 */
function checkPlan(file, text, roadmap, tracks = new Set()) {
  const lines = text.split(NL);
  const own = new Set(tracks);
  for (const l of lines.slice(0, 12))
    for (const m of l.matchAll(/\bTrack ([A-Z])\b/g)) own.add(m[1]);
  const findings = [];
  const defined = new Set();
  for (const r of tableRows(text)) {
    if (!own.has(trackOf(r.id))) continue;
    defined.add(r.id);
    const rm = lookup(roadmap, r.id);
    if (!roadmap.has(r.id) && rm !== undefined && /[a-z]$/.test(r.id)) continue; // a slice of a row
    if (rm === undefined) {
      findings.push({
        file,
        line: r.line,
        id: r.id,
        kind: "unlisted",
        detail: r.scope,
      });
    } else if (!matches(r.scope, rm)) {
      findings.push({
        file,
        line: r.line,
        id: r.id,
        kind: "drift",
        detail: r.scope,
        roadmap: rm,
      });
    }
  }
  lines.forEach((line, i) => {
    if (ROW_START.test(line)) return;
    const ids = new Set();
    for (const m of line.matchAll(BARE_ID))
      if (own.has(trackOf(m[1])) && !defined.has(m[1])) ids.add(m[1]);
    for (const m of line.matchAll(ROW_REF)) ids.add(m[1]);
    for (const id of ids) {
      const rm = lookup(roadmap, id);
      if (rm === undefined) {
        findings.push({
          file,
          line: i + 1,
          id,
          kind: "missing",
          detail: line.trim().slice(0, 140),
        });
      } else if (
        ids.size === 1 &&
        overlap(tokens(line.replace(BARE_ID, " ")), tokens(rm)) < 1
      ) {
        findings.push({
          file,
          line: i + 1,
          id,
          kind: "prose",
          detail: line.trim().slice(0, 140),
          roadmap: rm,
        });
      }
    }
  });
  return findings;
}

function run(plansDir) {
  const roadmapText = fs.readFileSync(
    path.join(plansDir, "ROADMAP.md"),
    "utf8",
  );
  const roadmap = parseRoadmap(roadmapText);
  const owners = planTracks(roadmapText);
  const findings = [];
  for (const f of fs.readdirSync(plansDir).sort()) {
    if (!f.endsWith(".md") || f === "ROADMAP.md") continue;
    findings.push(
      ...checkPlan(
        f,
        fs.readFileSync(path.join(plansDir, f), "utf8"),
        roadmap,
        owners.get(f),
      ),
    );
  }
  return { roadmap, findings };
}

module.exports = {
  lookup,
  tokens,
  tableRows,
  parseRoadmap,
  matches,
  planTracks,
  checkPlan,
  run,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const dir =
    args.find((a) => !a.startsWith("--")) ||
    path.join(__dirname, "..", "..", "plans");
  const { roadmap, findings } = run(dir);
  for (const f of findings) {
    const rm = f.roadmap
      ? `\n    ROADMAP ${f.id}: ${f.roadmap.slice(0, 120)}`
      : "";
    console.log(
      `${f.kind.padEnd(7)} ${f.file}:${f.line} ${f.id}: ${f.detail.slice(0, 120)}${rm}`,
    );
  }
  console.log(`\n${roadmap.size} ROADMAP ids, ${findings.length} findings`);
  // "prose" and "unlisted" are hints; only a table row whose scope disagrees
  // and a mention of an id ROADMAP lacks fail --strict.
  if (
    strict &&
    findings.some((f) => f.kind === "drift" || f.kind === "missing")
  )
    process.exit(1);
}
