const esc = (s) => String(s ?? "-").replace(/\|/g, "\\|");

function table(head, rows) {
  if (rows.length === 0) return "_none_\n";
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
    "",
  ].join("\n");
}

/** Markdown report on stdout. Nothing is written to the repository. */
export function report({ findings, uncovered }, dataset) {
  const out = [];
  out.push(`# Template classification vs preset table`, "");
  out.push(`Dataset fetched ${dataset.fetchedAt} by ${dataset.tool}.`, "");
  out.push("## Per repo", "");
  out.push(
    table(
      [
        "repo",
        "licence",
        "gated",
        "commit",
        "tools rendered",
        "template says",
        "row",
        "row says",
        "result",
      ],
      findings.map((f) => [
        f.repo,
        f.license,
        f.gated,
        f.sha ? f.sha.slice(0, 8) : null,
        f.template?.toolsRendered ?? null,
        f.template?.dialect ?? `undecided: ${f.template?.reason ?? f.status}`,
        f.row,
        f.rowDialect,
        f.kind,
      ]),
    ),
  );
  out.push("## Disagreements", "");
  out.push(
    table(
      ["repo", "detail"],
      findings
        .filter((f) => f.kind === "disagree")
        .map((f) => [f.repo, f.detail]),
    ),
  );
  out.push("## Undecided or unavailable", "");
  out.push(
    table(
      ["repo", "kind", "detail"],
      findings
        .filter((f) =>
          ["undecided", "novel", "unavailable", "unresolved"].includes(f.kind),
        )
        .map((f) => [f.repo, f.kind, f.detail]),
    ),
  );
  out.push("## Rows without a dataset repo", "");
  out.push(
    table(
      ["row", "why"],
      uncovered.map((u) => [u.row, u.kind]),
    ),
  );
  return out.join("\n");
}
