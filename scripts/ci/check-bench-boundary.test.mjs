import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  findViolations,
  reachesBench,
  scanSource,
} from "./check-bench-boundary.mjs";

const root = path.resolve("/repo");
const at = (p) => path.join(root, p);

test("relative paths into bench are caught, others are not", () => {
  const f = at("core/util/x.ts");
  assert.ok(reachesBench("../../bench/lab/adapter.mjs", f, root));
  assert.ok(reachesBench("../../bench", f, root));
  assert.ok(!reachesBench("../../benchmark/x", f, root));
  assert.ok(!reachesBench("./labContract", f, root));
  assert.ok(!reachesBench("vitest", f, root));
});

test("bare and package names are caught", () => {
  const f = at("gui/src/a.ts");
  assert.ok(reachesBench("bench/lab/lib/x.mjs", f, root));
  assert.ok(reachesBench("@b1tninja/continuous-bench", f, root));
  assert.ok(reachesBench("@b1tninja/continuous-local-lab/x", f, root));
  assert.ok(!reachesBench("@continuedev/fetch", f, root));
});

test("import, export-from, require and dynamic import forms", () => {
  const f = at("extensions/vscode/src/a.ts");
  const src = [
    'import a from "../../../bench/a";',
    'export * from "../../../bench/b";',
    'const c = require("../../../bench/c");',
    'const d = await import("../../../bench/d");',
    'import "../../../bench/e";',
    'import ok from "./fine";',
  ].join("\n");
  const found = scanSource(src, f, root);
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2, 3, 4, 5],
  );
});

test("a temporary tree: violation found, bench itself and node_modules skipped", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  try {
    const w = (p, s) => {
      fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
      fs.writeFileSync(path.join(tmp, p), s);
    };
    w("core/a.ts", 'import x from "../bench/lab/lib/x.mjs";\n');
    w("core/node_modules/p/i.js", 'require("../../../bench/x");\n');
    w("bench/lab/y.mjs", 'import "../../core/z.ts";\n');
    w("gui/ok.ts", 'import "./y";\n');
    const v = findViolations(tmp);
    assert.deepEqual(
      v.map((x) => [x.file.replaceAll("\\", "/"), x.line]),
      [["core/a.ts", 1]],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the real repository has no violation", () => {
  const here = path.resolve(import.meta.dirname, "..", "..");
  assert.deepEqual(findViolations(here), []);
});
