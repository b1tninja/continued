import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanHosts } from "./scanHosts";

/**
 * The runtime egress allowlist (plans/research/privacy-egress-licensing.md,
 * section 3, static layer). Every hostname written as a URL literal in
 * shipped source must be listed in egress-allowlist.json with a reason. A new
 * host fails here with its file and line, so adding a place the product might
 * talk to is a reviewed decision.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");

interface Group {
  class: string;
  reason: string;
  hosts: string[];
}

const allowlist: { groups: Group[]; denied: string[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "egress-allowlist.json"), "utf8"),
);
const allowed = new Map<string, Group>();
for (const g of allowlist.groups) {
  for (const h of g.hosts) allowed.set(h, g);
}

const hits = scanHosts(REPO_ROOT);

describe("egress allowlist", () => {
  it("finds the source tree", () => {
    expect(hits.length).toBeGreaterThan(50);
  });

  it("lists every hostname that appears in source", () => {
    const unlisted = hits
      .filter((h) => !allowed.has(h.host))
      .map((h) => `${h.host}  ${h.file}:${h.line}`);
    expect(
      unlisted,
      `New hostname(s) in source. Add each to core/egress/egress-allowlist.json with a reason, or remove the literal:\n${unlisted.join("\n")}`,
    ).toEqual([]);
  });

  it("has no stale entries and a reason for every group", () => {
    const seen = new Set(hits.map((h) => h.host));
    const stale = [...allowed.keys()].filter((h) => !seen.has(h));
    expect(stale, "listed but no longer in source").toEqual([]);
    for (const g of allowlist.groups) {
      expect(g.reason.length).toBeGreaterThan(20);
      expect(g.hosts.length).toBeGreaterThan(0);
    }
  });

  it("never allows a denied service host", () => {
    for (const suffix of allowlist.denied) {
      const bad = hits.filter((h) => h.host.endsWith(suffix));
      expect(
        bad.map((h) => `${h.host} ${h.file}:${h.line}`),
        `denied suffix ${suffix}`,
      ).toEqual([]);
    }
  });
});
