// The ONLY module of the lab that knows where the product checkout is. Every
// other file asks this one for a capability and gets either the product's own
// function or `null` (and a line in `product.missing`), so the lab still runs,
// with fewer features, when it is moved to its own repository and the product
// is not beside it.
//
// The product is TypeScript with extensionless and `.js`-for-`.ts` imports and
// a few constructor parameter properties, so plain Node cannot import it. A
// small load hook (Node's own `stripTypeScriptTypes` in transform mode, Node
// 22.13 or newer) does the two things needed. No npm package is involved.
//
// Product checkout: `--product <dir>`, else $LAB_PRODUCT_ROOT, else two levels
// above this file (the layout while the lab lives in bench/lab).
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HOOK = String.raw`
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
let ts = null;
export async function initialize(data) {
  if (data?.root) {
    try { ts = createRequire(data.root + "/package.json")("typescript"); } catch {}
  }
}
let n = 0;
// Stripping types does not drop a named import that is only a type, and the
// link then fails. Named imports become a namespace read, so a type that is
// not there reads as undefined and the rest links.
function looseImports(code) {
  return code.replace(/^import\s*(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*(["'][^"']+["']);?/gm, (_m, dflt, names, from) => {
    const ns = "__ns" + n++;
    const parts = names.split(",").map((x) => x.trim()).filter(Boolean)
      .map((x) => x.replace(/^type\s+/, ""))
      .map((x) => x.replace(/\s+as\s+/, ": "));
    return (dflt ? "import " + dflt + " from " + from + "; " : "") + "import * as " + ns + " from " + from + "; const { " + parts.join(", ") + " } = " + ns + ";";
  });
}
function transpile(src, file) {
  if (ts && typeof ts.transpileModule === "function") {
    return ts.transpileModule(src, {
      fileName: file,
      compilerOptions: { module: "esnext", target: "es2022" },
    }).outputText;
  }
  return looseImports(stripTypeScriptTypes(src, { mode: "transform" }));
}
export async function load(url, ctx, next) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const file = fileURLToPath(url);
    return { format: "module", shortCircuit: true, source: transpile(fs.readFileSync(file, "utf8"), file) };
  }
  return next(url, ctx);
}
const isDir = (u) => {
  try { return u.startsWith("file:") && fs.statSync(fileURLToPath(u)).isDirectory(); } catch { return false; }
};
export async function resolve(spec, ctx, next) {
  const rel = spec.startsWith(".") || spec.startsWith("/");
  try {
    const r = await next(spec, ctx);
    if (rel && isDir(r.url)) return next(spec.replace(/[/]$/, "") + "/index.ts", ctx);
    return r;
  } catch (e) {
    if (rel) {
      const bare = spec.replace(/[/]$/, "");
      for (const alt of [bare.replace(/[.]js$/, ".ts"), bare + ".ts", bare + "/index.ts"]) {
        try { return await next(alt, ctx); } catch {}
      }
    }
    // A type-only barrel such as core/index.d.ts has nothing to load.
    if (rel && e.code === "ERR_UNSUPPORTED_DIR_IMPORT")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    throw e;
  }
}
`;

let hooked = false;
function ensureHook(root) {
  if (hooked) return;
  register("data:text/javascript," + encodeURIComponent(HOOK), {
    parentURL: import.meta.url,
    data: { root },
  });
  hooked = true;
}

export function findProductRoot(explicit) {
  const cands = [
    explicit,
    process.env.LAB_PRODUCT_ROOT,
    path.resolve(HERE, "..", ".."),
  ].filter(Boolean);
  for (const c of cands) {
    const root = path.resolve(c);
    if (fs.existsSync(path.join(root, "core", "util", "toolDialectDetect.ts")))
      return root;
  }
  return null;
}

const PARSERS = [
  ["qwen-xml", "qwenXml", "recoverQwenXmlCalls"],
  ["hermes-json", "hermesJson", "recoverHermesJsonCalls"],
  ["glm-xml", "glmXml", "recoverGlmXmlCalls"],
  ["pythonic", "pythonic", "recoverPythonicCalls"],
  ["llama-json", "llamaJson", "recoverLlamaJsonCalls"],
];

/** Calls as `[{name, arguments}]`, or undefined; hides each parser's own shape. */
const normalise = (r) => {
  const calls = Array.isArray(r) ? r : r?.calls;
  return calls?.length
    ? calls.map((c) => ({ name: c.name, arguments: c.arguments }))
    : undefined;
};

/**
 * What the lab uses from the product. Every section may be null; `missing`
 * says why. Nothing here is written to: the product is read only.
 */
export async function loadProduct(explicitRoot) {
  const root = findProductRoot(explicitRoot);
  const p = {
    root,
    missing: [],
    detect: null,
    presets: null,
    parsers: {},
    fixtures: null,
    reviewer: null,
    agentTools: null,
  };
  if (!root) {
    p.missing.push(
      "product checkout not found (use --product or LAB_PRODUCT_ROOT)",
    );
    return p;
  }
  ensureHook(root);
  const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const attempt = async (what, fn) => {
    try {
      return await fn();
    } catch (e) {
      p.missing.push(`${what}: ${String(e.message).split("\n")[0]}`);
      return null;
    }
  };
  p.detect = await attempt("leak detector", () =>
    imp("core/util/toolDialectDetect.ts"),
  );
  // The table file imports types only. The lookup is three lines and mirrors
  // resolveToolDialectPreset (toolDialectPresets.ts), which is not imported
  // because it pulls in a workspace package.
  p.presets = await attempt("preset table", async () => {
    const m = await imp("core/util/toolDialectPresetTable.ts");
    const table = m.TOOL_DIALECT_PRESETS;
    return {
      table,
      resolve: (id) =>
        id
          ? table.find((r) => r.match.some((re) => re.test(id.toLowerCase())))
          : undefined,
    };
  });
  for (const [dialect, file, fn] of PARSERS) {
    const m = await attempt(`parser ${dialect}`, () =>
      imp(`packages/openai-adapters/src/dialects/${file}.ts`),
    );
    if (m?.[fn]) {
      p.parsers[dialect] = (text, tools) => {
        try {
          return normalise(m[fn](text, tools));
        } catch {
          return undefined;
        }
      };
    }
  }
  p.fixtures = await attempt("corpus fixture writer", () =>
    imp("core/llm/toolDialects/capture/fixture.ts"),
  );
  p.reviewer = await attempt("reviewer", async () => {
    const prompt = await imp("core/tools/permissions/auto/prompt.ts");
    const parse = await imp("core/tools/permissions/auto/parse.ts");
    const cases = await imp("core/tools/permissions/auto/evaluation/cases.ts");
    return {
      buildReviewMessages: prompt.buildReviewMessages,
      parseReviewerReply: parse.parseReviewerReply,
      cases: cases.EVAL_CASES,
      environment: cases.EVAL_ENVIRONMENT,
    };
  });
  // Needs the product's full install (core pulls in workspace packages), so it
  // is loaded on demand and a failure is the caller's to report. The lab ships
  // a frozen copy (fixtures/agent-tools.json) for when this is unavailable.
  p.agentTools = async () => {
    const m = await imp("core/llm/toolDialects/capture/tools.ts");
    return m.toWireTools(await m.realAgentTools());
  };
  return p;
}

/** The corpus fixtures the product keeps, for the `fixtures` command to list. */
export function corpusDir(product) {
  return product.root
    ? path.join(
        product.root,
        "core",
        "llm",
        "toolDialects",
        "corpus",
        "fixtures",
      )
    : null;
}
