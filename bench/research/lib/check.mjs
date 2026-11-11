import { resolveRow } from "./table.mjs";

/**
 * Compare a dataset with the preset rows. Classes per repo:
 *  agree, disagree, undecided (never counted as agree), unresolved (no row
 *  matches the repo name), unavailable (gated, private, missing, or no template).
 * Rows with no dataset repo are listed as uncovered, or as "no public template"
 * when none of their sources is a Hugging Face URL.
 */
export function compare(rows, dataset) {
  const findings = [];
  const covered = new Set();
  for (const rec of Object.values(dataset.repos)) {
    const row = resolveRow(rows, rec.repo);
    const base = {
      repo: rec.repo,
      row: row?.id ?? null,
      rowDialect: row?.textDialect ?? null,
      template: rec.template,
      status: rec.status,
      license: rec.license ?? null,
      gated: rec.gated ?? null,
      sha: rec.sha ?? null,
    };
    if (row) covered.add(row.id);
    if (rec.status !== "ok") {
      findings.push({ ...base, kind: "unavailable", detail: rec.detail });
    } else if (!row) {
      findings.push({
        ...base,
        kind: "unresolved",
        detail: `no preset row matches; template says ${rec.template.dialect ?? rec.template.reason}`,
      });
    } else if (rec.template.outcome === "undecided") {
      findings.push({
        ...base,
        kind: "undecided",
        detail: rec.template.reason,
      });
    } else if (rec.template.dialect === row.textDialect) {
      findings.push({ ...base, kind: "agree", detail: rec.template.dialect });
    } else {
      findings.push({
        ...base,
        kind: "disagree",
        detail: `template says ${rec.template.dialect}, row ${row.id} says ${row.textDialect}`,
      });
    }
  }
  const uncovered = rows
    .filter((r) => !covered.has(r.id))
    .map((r) => ({
      row: r.id,
      kind: r.sources.some((s) => s.includes("huggingface.co"))
        ? "not-in-dataset"
        : "no-public-template",
    }));
  return { findings, uncovered };
}

export function summarise({ findings, uncovered }) {
  const n = (k) => findings.filter((f) => f.kind === k).length;
  return {
    agree: n("agree"),
    disagree: n("disagree"),
    undecided: n("undecided"),
    unresolved: n("unresolved"),
    unavailable: n("unavailable"),
    uncovered: uncovered.length,
  };
}

/** 0 clean, 1 disagreement (or undecided under strict). 2 is for failures, raised by the caller. */
export function exitCode(result, { strict = false } = {}) {
  const s = summarise(result);
  if (s.disagree > 0) return 1;
  if (strict && (s.undecided > 0 || s.unavailable > 0 || s.unresolved > 0)) {
    return 1;
  }
  return 0;
}

export function formatCheck(result, { strict = false } = {}) {
  const lines = [];
  for (const f of result.findings) {
    if (f.kind === "agree") continue;
    lines.push(
      `${f.kind.toUpperCase().padEnd(11)} ${f.repo}  [row ${f.row ?? "-"}]  ${f.detail ?? ""}`,
    );
  }
  for (const u of result.uncovered)
    lines.push(`${"UNCOVERED".padEnd(11)} row ${u.row}  (${u.kind})`);
  const s = summarise(result);
  lines.push(
    `agree ${s.agree}, disagree ${s.disagree}, undecided ${s.undecided}, unresolved ${s.unresolved}, unavailable ${s.unavailable}, rows uncovered ${s.uncovered}` +
      (strict ? " (strict)" : ""),
  );
  return lines.join("\n");
}
