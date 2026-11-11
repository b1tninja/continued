import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyEnvName } from "./envNames";
import { GIT_ENV } from "./gitEnvClasses";

/**
 * ROADMAP P15. The names are a checked-in snapshot of the git manual (see the
 * `comment` in corpus/gitEnvNames.json for URLs and fetch date) so CI needs no
 * network. A name the manual lists must have a row in gitEnvClasses.ts, and
 * the row must be what `classifyEnvName` really answers.
 */
interface Snapshot {
  fetched: string;
  git1: string[];
  gitConfig: string[];
  extra: string[];
}
const snap: Snapshot = JSON.parse(
  readFileSync(join(__dirname, "corpus", "gitEnvNames.json"), "utf8"),
);
const all = [...snap.git1, ...snap.gitConfig, ...snap.extra];
const sample = (n: string) => n.replace("<n>", "0");

describe("GIT_* names are classified deliberately", () => {
  it("the snapshot is dated and holds names only", () => {
    expect(snap.fetched).toBe("2026-11-11");
    expect(snap.git1.length).toBeGreaterThan(60);
    for (const n of all) expect(n).toMatch(/^GIT_[A-Z0-9_]+(<n>)?$/);
  });

  it("every name in the manual has a row", () => {
    expect(all.filter((n) => !GIT_ENV[n])).toEqual([]);
  });

  it("no row names a variable that is not in the snapshot", () => {
    expect(Object.keys(GIT_ENV).filter((n) => !all.includes(n))).toEqual([]);
  });

  it("every row has a reason and agrees with classifyEnvName", () => {
    for (const [name, row] of Object.entries(GIT_ENV)) {
      expect(row.why.length, name).toBeGreaterThan(8);
      expect(classifyEnvName(sample(name)).risk, name).toBe(row.risk);
    }
  });

  it("only identity, prompt, lock, flush and curl-diagnostic names are harmless", () => {
    const harmless = Object.entries(GIT_ENV)
      .filter(([, r]) => r.risk === "harmless")
      .map(([n]) => n)
      .sort();
    expect(harmless).toEqual(
      [
        "GIT_AUTHOR_DATE",
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_NAME",
        "GIT_COMMITTER_DATE",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_CURL_VERBOSE",
        "GIT_FLUSH",
        "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT",
      ].sort(),
    );
  });

  it("a name the manual gains later is dangerous until it is read", () => {
    expect(classifyEnvName("GIT_SOME_NEW_THING").risk).toBe("dangerous");
    expect(classifyEnvName("git_exec_path").risk).toBe("dangerous");
  });

  it("every name that runs a program is dangerous", () => {
    for (const [name, row] of Object.entries(GIT_ENV)) {
      if (row.why.startsWith("runs:")) expect(row.risk, name).toBe("dangerous");
    }
  });
});
