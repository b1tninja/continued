import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIX = join(HERE, "fixtures");

export function labels() {
  return JSON.parse(readFileSync(join(FIX, "labels.json"), "utf8"));
}
export function template(file) {
  return readFileSync(join(FIX, "templates", file), "utf8");
}
export function dataset() {
  return JSON.parse(readFileSync(join(FIX, "dataset.json"), "utf8"));
}

/** A table text in the same layout as core/util/toolDialectPresetTable.ts. */
export function tableText(rows) {
  const body = rows
    .map(
      (r) => `  {
    id: "${r.id}",
    label: "x",
    match: [${r.match}],
    textDialect: "${r.dialect}",
    ${r.vllm ? `serverParser: { vllm: "${r.vllm}", basis: "vllm-docs" },` : ""}
    source: [${(r.sources ?? []).map((s) => JSON.stringify(s)).join(", ")}],
    readOn: READ,
  },`,
    )
    .join("\n");
  return `const READ = "2026-11-10";\nexport const TOOL_DIALECT_PRESETS: DialectPreset[] = [\n${body}\n];\n`;
}

const HF = ["https://huggingface.co/x/y"];
/** Rows that agree with every decided verdict in fixtures/dataset.json. */
export const AGREEING_ROWS = [
  {
    id: "qwen3-coder",
    match: "/qwen[-._ ]?3[-._ ]?coder/",
    dialect: "qwen-xml",
    sources: HF,
  },
  {
    id: "qwen35",
    match: "/qwen[-._ ]?3[.]?[56]|nemotron[-._ ]?3/",
    dialect: "qwen-xml",
    sources: HF,
  },
  {
    id: "qwen3",
    match: "/qwen[-._ ]?3|hermes/",
    dialect: "hermes-json",
    sources: HF,
  },
  { id: "glm", match: "/glm/", dialect: "glm-xml", sources: HF },
  { id: "kimi", match: "/kimi/", dialect: "kimi-tokens", sources: HF },
  { id: "minimax", match: "/minimax/", dialect: "minimax-xml", sources: HF },
  {
    id: "nemotron",
    match: "/nemotron/",
    dialect: "toolcall-json",
    sources: HF,
  },
  {
    id: "deepseek",
    match: "/deepseek/",
    dialect: "deepseek-tokens",
    sources: HF,
  },
  { id: "gpt-oss", match: "/gpt[-._ ]?oss/", dialect: "harmony", sources: HF },
  { id: "gemma-4", match: "/gemma[-._ ]?4/", dialect: "gemma4", sources: HF },
  { id: "gemma-3", match: "/gemma[-._ ]?3/", dialect: "none", sources: HF },
  { id: "llama", match: "/llama/", dialect: "llama-json", sources: HF },
  { id: "mistral", match: "/mistral/", dialect: "mistral", sources: HF },
  { id: "claude", match: "/claude/", dialect: "none", sources: [] },
];
