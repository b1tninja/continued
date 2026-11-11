import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetShadowForTests, startShadowReview } from "./shadowHook.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-shadow-hook-"));
  resetShadowForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = { id: "c1", name: "Bash", arguments: { command: "ls" } };

describe("startShadowReview", () => {
  it("starts nothing unless the person's own config turned it on with a budget", () => {
    const file = path.join(dir, "config.yaml");
    // no file
    expect(
      startShadowReview(call, {}, { approved: true }, file),
    ).toBeUndefined();
    for (const text of [
      "audit:\n  shadowReviewer:\n    enabled: true\n",
      "audit:\n  shadowReviewer:\n    enabled: false\n    budgetUsd: 1\n",
      "name: assistant\n",
    ]) {
      fs.writeFileSync(file, text);
      expect(
        startShadowReview(call, {}, { approved: true }, file),
      ).toBeUndefined();
    }
  });

  it("does not shadow a call a loop held as a question", () => {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(
      file,
      "audit:\n  shadowReviewer:\n    enabled: true\n    budgetUsd: 1\n",
    );
    expect(
      startShadowReview(call, { held: true }, { approved: false }, file),
    ).toBeUndefined();
  });
});
