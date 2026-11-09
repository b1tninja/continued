import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "./verdictReport";

const REPORT = path.resolve(
  __dirname,
  "../../../../plans/command-analysis-report.md",
);

describe("plans/command-analysis-report.md", () => {
  it("is what the corpus produces now", () => {
    const now = buildReport();
    if (process.env.WRITE_CORPUS_REPORT) {
      fs.writeFileSync(REPORT, now, "utf-8");
    }
    const written = fs.readFileSync(REPORT, "utf-8").replace(/\r\n/g, "\n");
    expect(written).toBe(now);
  });
});
