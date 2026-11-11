import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPackage, isExact, run } from "./check-pins.mjs";

test("isExact accepts versions and rejects ranges", () => {
  assert.ok(isExact("1.64.0"));
  assert.ok(isExact("1.0.0-beta.1"));
  for (const s of [
    "^1.0.0",
    "~1.0.0",
    "1.x",
    "*",
    "latest",
    ">=1",
    "file:../x",
  ])
    assert.ok(!isExact(s), s);
});

test("zero-dependency folders fail when they gain a dependency", () => {
  assert.deepEqual(checkPackage({}, { enforceAll: true, maxDeps: 0 }), []);
  assert.equal(
    checkPackage(
      { dependencies: { a: "1.0.0" } },
      { enforceAll: true, maxDeps: 0 },
    ).length,
    1,
  );
});

test("sandbox-runtime must be exact anywhere", () => {
  const bad = { dependencies: { "@anthropic-ai/sandbox-runtime": "^0.0.82" } };
  assert.equal(checkPackage(bad, { enforceAll: false }).length, 1);
  const ok = {
    dependencies: { "@anthropic-ai/sandbox-runtime": "0.0.82", x: "^1.0.0" },
  };
  assert.deepEqual(checkPackage(ok, { enforceAll: false }), []);
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "pins-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), JSON.stringify(c));
  }
  return root;
}

test("a dev-only folder with dependencies needs a lockfile with integrity", () => {
  const pkg = { dependencies: { p: "1.0.0" } };
  const noLock = tree({ "bench/screenshots/package.json": pkg });
  assert.match(run(noLock).join("\n"), /no package-lock/);
  const noHash = tree({
    "bench/screenshots/package.json": pkg,
    "bench/screenshots/package-lock.json": {
      packages: { "": {}, "node_modules/p": { version: "1.0.0" } },
    },
  });
  assert.match(run(noHash).join("\n"), /no integrity/);
  const good = tree({
    "bench/screenshots/package.json": pkg,
    "bench/screenshots/package-lock.json": {
      packages: { "": {}, "node_modules/p": { integrity: "sha512-x" } },
    },
  });
  assert.deepEqual(run(good), []);
});

test("the repository itself passes", () => {
  assert.deepEqual(run(join(import.meta.dirname, "..", "..")), []);
});
