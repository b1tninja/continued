import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findProductRoot, loadProduct } from "../adapter.mjs";

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function mjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory())
      return e.name === "results" || e.name === "profiles" ? [] : mjsFiles(p);
    return p.endsWith(".mjs") ? [p] : [];
  });
}

test("portability: only adapter.mjs knows about the product", () => {
  for (const file of mjsFiles(LAB)) {
    if (path.basename(file) === "adapter.mjs") continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      assert.ok(
        !/core\/|packages\/|toolDialect|\.\.\/\.\.\//.test(spec),
        `${path.relative(LAB, file)} imports ${spec}`,
      );
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(
          target.startsWith(LAB),
          `${path.relative(LAB, file)} reaches outside the lab: ${spec}`,
        );
      }
    }
  }
});

test("the product checkout comes from the argument, then the environment", () => {
  assert.equal(
    findProductRoot(path.join(LAB, "nowhere")),
    findProductRoot(undefined) ?? null,
  );
  const old = process.env.LAB_PRODUCT_ROOT;
  try {
    process.env.LAB_PRODUCT_ROOT = path.join(LAB, "also-nowhere");
    const root = findProductRoot(undefined);
    assert.ok(
      root === null ||
        fs.existsSync(path.join(root, "core", "util", "toolDialectDetect.ts")),
    );
  } finally {
    if (old === undefined) delete process.env.LAB_PRODUCT_ROOT;
    else process.env.LAB_PRODUCT_ROOT = old;
  }
});

test("a lab without a product still loads and says what is missing", async () => {
  const old = process.env.LAB_PRODUCT_ROOT;
  process.env.LAB_PRODUCT_ROOT = path.join(LAB, "nowhere");
  try {
    // an explicit bad path falls through to the default location; point both at nothing
    const p = await loadProduct(path.join(LAB, "nowhere"));
    assert.ok(Array.isArray(p.missing));
    if (!p.root) assert.match(p.missing[0], /product checkout not found/);
  } finally {
    if (old === undefined) delete process.env.LAB_PRODUCT_ROOT;
    else process.env.LAB_PRODUCT_ROOT = old;
  }
});

test("with the product beside it, the adapter exports parsers, detector, table and reviewer", async (t) => {
  const p = await loadProduct();
  if (!p.root) return t.skip("no product checkout");
  assert.deepEqual(Object.keys(p.parsers).sort(), [
    "glm-xml",
    "hermes-json",
    "llama-json",
    "pythonic",
    "qwen-xml",
  ]);
  assert.equal(typeof p.detect.classifyToolReply, "function");
  assert.ok(p.presets.table.length > 10);
  assert.equal(p.presets.resolve("qwen3.6:27b").id, "qwen3.5-3.8");
  assert.equal(p.presets.resolve("glm-ocr:latest"), undefined);
  assert.equal(typeof p.reviewer.parseReviewerReply, "function");
  assert.equal(typeof p.fixtures.buildFixture, "function");
  const call = p.parsers["hermes-json"](
    '<tool_call>\n{"name":"read_file","arguments":{"path":"a"}}\n</tool_call>',
    [
      {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
  );
  assert.deepEqual(call, [{ name: "read_file", arguments: { path: "a" } }]);
});

test("the frozen agent tool list is the real shape", () => {
  const tools = JSON.parse(
    fs.readFileSync(path.join(LAB, "fixtures", "agent-tools.json"), "utf8"),
  );
  assert.ok(tools.length >= 20);
  assert.ok(tools.every((t) => t.name && t.parameters?.type === "object"));
  assert.ok(tools.some((t) => t.name === "read_file"));
});
