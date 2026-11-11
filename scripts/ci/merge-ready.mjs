#!/usr/bin/env node
// Read-only merge planner for the serial-merge protocol (docs/ci-merge-gate.md).
//   node scripts/ci/merge-ready.mjs 518 519 520 [--repo owner/name] [--combine]
// --combine: fresh `git fetch origin` of main and each PR head into refs/combine/*, then a pairwise
// `git merge-tree --write-tree` matrix (does A conflict when merged after B) and the hot-file list.
// --trial: also merge each PR head with the tip of main in the object database and list the projects
// (core, gui, binary) the merged result must be type-checked and linted in; with --run it does that in
// a temporary worktree, linking node_modules from --deps <checkout> (default: the current directory).
// No checkout; nothing is written to the working tree or index.
// For each PR: is the head up to date with main, what is the `merge-gate` state, does it conflict.
// Then prints a safe merge order. It never merges, updates a branch, or reruns anything.
import { execFileSync } from "node:child_process";
import { runTrial, trialPlan } from "./trial-merge.mjs";
import { HOT, combineMatrix, fetchPrRefs, formatMatrix } from "./combine.mjs";

const args = process.argv.slice(2);
let repo = "b1tninja/continuous";
const ri = args.indexOf("--repo");
if (ri >= 0) repo = args.splice(ri, 2)[1];
const ci = args.indexOf("--combine");
const combine = ci >= 0;
if (combine) args.splice(ci, 1);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const trial = flag("--trial");
const runTrialChecks = flag("--run");
const di = args.indexOf("--deps");
const deps = di >= 0 ? args.splice(di, 2)[1] : process.cwd();
const numbers = args.filter((a) => /^\d+$/.test(a)).map(Number);
if (!numbers.length) {
  console.error("usage: merge-ready.mjs <pr> [<pr> ...] [--repo owner/name]");
  process.exit(2);
}

if (combine) {
  const { main, prs } = fetchPrRefs(process.cwd(), numbers);
  console.log(formatMatrix(combineMatrix(process.cwd(), main, prs)));
  console.log();
}

let trialFailed = false;
if (trial) {
  const { main, prs } = fetchPrRefs(process.cwd(), numbers);
  console.log("Trial merge with the tip of main:");
  for (const [name, ref] of Object.entries(prs)) {
    const p = trialPlan(process.cwd(), main, ref);
    if (p.conflict) {
      trialFailed = true;
      console.log(`  ${name}: CONFLICT in ${p.files.join(", ")}`);
    } else if (p.behind === 0) {
      console.log(`  ${name}: head contains main, nothing to try`);
    } else if (!p.projects.length) {
      console.log(
        `  ${name}: behind ${p.behind}, merges clean, no code project touched`,
      );
    } else if (!runTrialChecks) {
      console.log(
        `  ${name}: behind ${p.behind}, merges clean; check ${p.projects.join(", ")} (rerun with --run)`,
      );
    } else {
      const res = runTrial(process.cwd(), p.commit, p.projects, deps);
      const bad = res.filter((r) => r.status !== 0);
      if (bad.length) trialFailed = true;
      console.log(
        `  ${name}: ${bad.length ? "FAILED " + bad.map((r) => r.project + ": " + r.cmd).join("; ") : "ok (" + res.map((r) => r.project).join(", ") + ")"}`,
      );
    }
  }
  console.log();
}

const gh = (...a) =>
  execFileSync("gh", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const json = (...a) => JSON.parse(gh(...a));

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
if (trialFailed) process.exitCode = 1;
