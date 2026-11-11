import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CORPUS,
  DATASET,
  TEMPLATES,
  huggingFaceRepo,
  inspect,
} from "./check-notice.mjs";

test("repo extraction", () => {
  assert.equal(
    huggingFaceRepo(
      "synthesised from template https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/x",
    ),
    "Qwen/Qwen3-30B-A3B",
  );
  assert.equal(huggingFaceRepo("observed live"), null);
});

test("counts missing source, missing licence, restrictive and long excerpts", () => {
  const root = mkdtempSync(join(tmpdir(), "notice-"));
  for (const d of [CORPUS, TEMPLATES, join(DATASET, "..")])
    mkdirSync(join(root, d), { recursive: true });
  const fx = (name, provenance) =>
    writeFileSync(join(root, CORPUS, name), JSON.stringify({ provenance }));
  fx("a.json", {
    source: "from https://huggingface.co/moonshotai/Kimi-K3/blob/main/t",
  });
  fx("b.json", { source: "from https://huggingface.co/x/y", license: "mit" });
  fx("c.json", {});
  writeFileSync(
    join(root, DATASET),
    JSON.stringify({ repos: { "moonshotai/Kimi-K3": { license: "other" } } }),
  );
  writeFileSync(join(root, TEMPLATES, "t.jinja"), "x".repeat(1201));
  const r = inspect(root);
  assert.equal(r.total, 3);
  assert.deepEqual(r.missingSource, ["c.json"]);
  assert.equal(r.hf, 2);
  assert.deepEqual(r.missingLicence, ["a.json"]);
  assert.deepEqual([...r.restrictive], [["moonshotai/Kimi-K3", "other"]]);
  assert.equal(r.longExcerpts.length, 1);
});

test("the repository itself passes --strict: every Hugging Face fixture names a licence, no excerpt is too long", () => {
  const r = inspect(join(import.meta.dirname, "..", ".."));
  assert.deepEqual(r.missingSource, []);
  assert.deepEqual(r.missingLicence, []);
  assert.deepEqual(r.longExcerpts, []);
  assert.ok(r.hf > 0);
});
