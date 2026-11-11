#!/usr/bin/env node
// Read-only merge planner for the serial-merge protocol (docs/ci-merge-gate.md).
//   node scripts/ci/merge-ready.mjs 518 519 520 [--repo owner/name]
// For each PR: is the head up to date with main, what is the `merge-gate` state, does it conflict.
// Then prints a safe merge order. It never merges, updates a branch, or reruns anything.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let repo = "b1tninja/continuous";
const ri = args.indexOf("--repo");
if (ri >= 0) repo = args.splice(ri, 2)[1];
const numbers = args.filter((a) => /^\d+$/.test(a)).map(Number);
if (!numbers.length) {
  console.error("usage: merge-ready.mjs <pr> [<pr> ...] [--repo owner/name]");
  process.exit(2);
}

const gh = (...a) =>
  execFileSync("gh", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const json = (...a) => JSON.parse(gh(...a));

// Files that feature branches tend to share; two PRs sharing one must be merged serially.
const HOT = [
  /dialect/i,
  /loadYaml\.ts$/,
  /evaluate\.ts$/,
  /extensions\/cli\/src\/index\.ts$/,
  /ROADMAP/i,
  /recovery/i,
];

function gateState(sha) {
  const pages = json(
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
  );
  const list = pages.flatMap((p) => p.check_runs ?? []);
  const gate = list.find((r) => r.name === "merge-gate");
  if (!gate) return "missing";
  return gate.status === "completed" ? gate.conclusion : gate.status;
}

const rows = numbers.map((n) => {
  const pr = json(
    "pr",
    "view",
    String(n),
    "--repo",
    repo,
    "--json",
    "number,title,headRefOid,mergeable,isDraft,state,files",
  );
  const behind = json(
    "api",
    `repos/${repo}/compare/main...${pr.headRefOid}`,
  ).behind_by;
  return {
    n,
    title: pr.title,
    state: pr.state,
    draft: pr.isDraft,
    behind,
    conflict: pr.mergeable === "CONFLICTING",
    gate: gateState(pr.headRefOid),
    files: new Set(pr.files.map((f) => f.path)),
  };
});

const overlap = (a, b) => [...a.files].filter((f) => b.files.has(f));
console.log("PR     up-to-date  gate         conflict  notes");
for (const r of rows) {
  const notes = [r.draft && "draft", r.state !== "OPEN" && r.state]
    .filter(Boolean)
    .join(",");
  console.log(
    `#${String(r.n).padEnd(5)} ${(r.behind === 0 ? "yes" : `behind ${r.behind}`).padEnd(11)} ` +
      `${String(r.gate).padEnd(12)} ${(r.conflict ? "CONFLICT" : "no").padEnd(9)} ${notes}`,
  );
}

// Mergeable now (open, not draft, no conflict, gate success, up to date) first, then those that
// need an update, then conflicting ones, then closed/draft; ties by number (oldest first).
const rank = (r) =>
  r.state !== "OPEN" || r.draft
    ? 3
    : r.conflict
      ? 2
      : r.behind === 0 && r.gate === "success"
        ? 0
        : 1;
const order = [...rows].sort((a, b) => rank(a) - rank(b) || a.n - b.n);

console.log("\nSafe merge order (one at a time):");
order.forEach((r, i) => {
  const later = order.slice(i + 1).filter((o) => overlap(r, o).length);
  const hot = later
    .flatMap((o) => overlap(r, o))
    .filter((f) => HOT.some((h) => h.test(f)));
  const todo = [];
  if (r.draft) todo.push("mark ready");
  if (r.conflict) todo.push("resolve conflicts");
  else if (r.behind > 0) todo.push("update branch");
  if (r.gate !== "success") todo.push("wait for merge-gate");
  console.log(
    `  ${i + 1}. #${r.n}${todo.length ? "  (first: " + todo.join(", ") + ")" : "  (ready)"}`,
  );
  if (later.length)
    console.log(
      `       after it merges: update branch + rerun gate on ${later.map((o) => "#" + o.n).join(", ")}` +
        (hot.length ? `  [hot files: ${[...new Set(hot)].join(", ")}]` : ""),
    );
});
