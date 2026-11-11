import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("surfaceFacts.generated.json", () => {
  it("passes scripts/ci/check-surface-facts.mjs", () => {
    const root = path.resolve(__dirname, "..", "..");
    const r = spawnSync(
      "node",
      [path.join(root, "scripts", "ci", "check-surface-facts.mjs")],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("surface facts ok");
  });
});
