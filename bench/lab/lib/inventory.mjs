// `inventory`: what is installed, what each model maps to in the preset
// table, and which are safe to run under the guards. Read only: /api/tags,
// /api/show and /api/ps never load a model.
import { GB, modelGuard } from "./guards.mjs";
import { presetFor } from "./run.mjs";

export async function inventory({ client, product, limits, facts }) {
  const tags = (await client.tags()).models ?? [];
  let loaded = [];
  try {
    loaded = ((await client.ps()).models ?? []).map((m) => ({
      name: m.name,
      sizeGB: m.size / GB,
      vramGB: (m.size_vram ?? 0) / GB,
    }));
  } catch {
    /* ps is advisory */
  }
  const models = [];
  for (const t of tags) {
    let show = {};
    try {
      show = await client.show(t.name);
    } catch {
      /* keep what tags gave */
    }
    const d = t.details ?? {};
    const caps = show.capabilities ?? t.capabilities ?? [];
    const info = show.model_info ?? {};
    const arch = info["general.architecture"] ?? d.family;
    const ctx = info[`${arch}.context_length`] ?? d.context_length;
    const template = show.template ?? "";
    const dialect = product?.detect?.dialectFromChatTemplate?.(template);
    const preset =
      presetFor(product, t.name) ?? presetFor(product, t.model ?? "");
    const row = {
      name: t.name,
      size: t.size,
      sizeGB: t.size / GB,
      family: d.family,
      params: d.parameter_size,
      quant: d.quantization_level,
      context: ctx,
      capabilities: caps,
      toolsCapable: caps.includes("tools"),
      templateMentionsTools: /\.Tools|tools/i.test(template),
      templateDialect: dialect
        ? `${dialect.dialect} (${dialect.confidence})`
        : null,
      parser: show.parser ?? null,
      preset: preset
        ? {
            id: preset.id,
            textDialect: preset.textDialect,
            promptStyle: preset.promptStyle.style,
          }
        : null,
    };
    row.guard = modelGuard(
      { name: t.name, sizeBytes: t.size, capabilities: caps, family: d.family },
      limits,
      facts,
    );
    row.safe = row.guard.ok && row.toolsCapable;
    if (row.guard.ok && !row.toolsCapable)
      row.guard = { ok: false, reasons: ["no tools capability reported"] };
    models.push(row);
  }
  models.sort((a, b) => a.size - b.size);
  return { facts, loaded, models };
}

const f1 = (x) => (x == null ? "?" : x.toFixed(1));

export function formatInventory(inv, limits) {
  const L = [];
  const { facts } = inv;
  L.push("# Local lab inventory", "");
  L.push("## Machine", "");
  for (const g of facts.gpus ?? [])
    L.push(
      `- GPU ${g.name}: ${f1(g.totalGB)} GB VRAM, ${f1(g.freeGB)} GB free (nvidia-smi)`,
    );
  if (!facts.gpus)
    L.push(
      "- GPU: nvidia-smi not available, VRAM unknown (the --max-vram limit still applies)",
    );
  L.push(
    `- RAM: ${f1(facts.ramTotalGB)} GB total, ${f1(facts.ramFreeGB)} GB free`,
  );
  L.push(
    `- Models directory: ${facts.modelsDir} (${facts.modelsDirFromEnv ? "OLLAMA_MODELS" : "default location"}); ${f1(facts.modelsDiskFreeGB)} GB free of ${f1(facts.modelsDiskTotalGB)} GB on its drive`,
  );
  L.push(
    `- Loaded now: ${inv.loaded.length ? inv.loaded.map((m) => `${m.name} (${f1(m.sizeGB)} GB)`).join(", ") : "nothing"}`,
  );
  L.push(
    `- Limits: --max-vram ${limits.maxVramGB} GB, --max-ram ${limits.maxRamGB} GB (sizes are GB of weights as Ollama reports them)`,
    "",
  );
  L.push("## Models (smallest first)", "");
  L.push(
    "| model | GB | params | quant | family | ctx | tools | preset row | prompt style | safe to run |",
  );
  L.push("| --- | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |");
  for (const m of inv.models) {
    const tools = m.toolsCapable
      ? m.templateMentionsTools
        ? "yes (template)"
        : "yes"
      : "no";
    L.push(
      `| ${m.name} | ${f1(m.sizeGB)} | ${m.params ?? "?"} | ${m.quant ?? "?"} | ${m.family ?? "?"} | ${m.context ?? "?"} | ${tools} | ${m.preset?.id ?? "none"} | ${m.preset?.promptStyle ?? "codeblock (default)"} | ${m.safe ? "yes" : "no: " + m.guard.reasons.join("; ")} |`,
    );
  }
  const safe = inv.models.filter((m) => m.safe);
  L.push(
    "",
    safe.length
      ? `Smallest safe model: ${safe[0].name} (${f1(safe[0].sizeGB)} GB).`
      : "No installed model is safe under the current limits; raise --max-vram/--max-ram on purpose to run a larger one.",
  );
  return L.join("\n") + "\n";
}
