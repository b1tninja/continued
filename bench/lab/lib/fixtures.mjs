// `fixtures`: raw replies promoted to observed corpus fixtures (the product's
// I23 format), written under results/fixtures. The writer is the product's
// own buildFixture, reached through the adapter, so the format cannot drift.
// Every record keeps its raw reply in the JSONL regardless; this is the step
// that makes a reply loadable by the corpus runner. Nothing goes into the
// product: a person copies files across after reading them.
import path from "node:path";
import { slug, writeText } from "./paths.mjs";
import { expandSuite } from "./suites.mjs";
import { presetFor } from "./run.mjs";

const OUTCOME = {
  "text-call": "leak",
  "format-broken": "leak",
  structured: "structured",
  refused: "refused",
  prose: "refused",
};

export function writeFixtures({
  product,
  suite,
  records,
  roots,
  opts = {},
  agentTools,
  date = new Date().toISOString().slice(0, 10),
}) {
  if (!product?.fixtures?.buildFixture)
    throw new Error(
      "fixtures need the product's corpus fixture writer (adapter: " +
        (product?.missing ?? []).join("; ") +
        ")",
    );
  const out = [];
  const byModel = new Map();
  for (const r of records) {
    if (r.suite !== suite.suite || r.outcome === "error" || !r.reply?.text)
      continue;
    if (opts.onlyLeaks && !["text-call", "format-broken"].includes(r.outcome))
      continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  for (const [model, rs] of byModel) {
    const cases = new Map(
      expandSuite(suite, {
        model,
        preset: presetFor(product, model),
        product,
        opts,
        agentTools,
      }).map((c) => [c.id, c]),
    );
    for (const r of rs) {
      const c = cases.get(r.caseId);
      if (!c) continue;
      const id =
        `lab-${slug(model)}-${slug(suite.suite)}-${slug(r.caseId)}-p${r.pass}`.toLowerCase();
      const fx = product.fixtures.buildFixture(
        {
          text: r.reply.text,
          toolCalls: r.reply.toolCalls ?? [],
          stopReason: r.reply.doneReason,
          usage: {
            inputTokens: r.usage?.promptTokens,
            outputTokens: r.usage?.outputTokens,
          },
          chunks: r.reply.chunks,
        },
        {
          id,
          model,
          transport: "openai",
          date: String(r.ts).slice(0, 10) || date,
          streamed: !!r.stream,
          temperature: r.temperature,
          tools: c.tools,
          classified: {
            outcome: OUTCOME[r.outcome] ?? "refused",
            dialect: r.detected ?? "none",
          },
        },
      );
      if (!fx) continue;
      fx.provenance.source = `Observed live on a local Ollama ${String(r.ts).slice(0, 10)}, model ${model} (local lab, suite ${suite.suite})`;
      const file = path.join(roots.results, "fixtures", `${id}.json`);
      writeText(file, JSON.stringify(fx, null, 2) + "\n", roots);
      out.push(file);
    }
  }
  return out;
}
