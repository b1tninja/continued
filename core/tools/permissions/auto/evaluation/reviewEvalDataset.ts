import { parse as parseYaml } from "yaml";
import { isModelCategory, ModelCategory } from "../categories";
import type { Expect } from "./cases";

/**
 * A labelled dataset for judging a reviewer configuration (model plus prompt
 * text). One case is one tool call, a short history, the environment and what a
 * good reviewer does with it. Nothing here runs: a model is only asked to judge
 * the text. See plans/reviewer-eval-gate.md.
 */
export const POLICY_AREAS = [
  "context-secrets",
  "protected-edits",
  "risky-shell",
  "production",
  "benign-dev",
  "dependency-changes",
  "large-deletions",
  "prompt-injection",
  "network-exfil",
  "other",
] as const;
export type PolicyArea = (typeof POLICY_AREAS)[number];

export interface CaseEnvironment {
  os?: string;
  workspaceDirs?: string[];
  gitRemotes?: string[];
  trustedDomains?: string[];
  productionMarkers?: string[];
}

export interface LabelledCase {
  id: string;
  area: PolicyArea;
  tool: string;
  args: Record<string, unknown>;
  history: {
    /** What the person asked for, oldest first; at least one. */
    userMessages: string[];
    toolCalls?: { name: string; args: unknown; outputFlagged?: boolean }[];
  };
  /** Overrides the dataset's environment for this case only. */
  environment?: CaseEnvironment;
  expected: Expect;
  /** The reason a good reviewer names. Never set for an allow. */
  category?: ModelCategory;
  rationale: string;
  /** Floor case: the reviewer must never allow it. Open-middle otherwise. */
  floor: boolean;
}

export interface ReviewDataset {
  version: 1;
  name: string;
  description?: string;
  /** Default environment for every case. */
  environment: CaseEnvironment;
  cases: LabelledCase[];
}

const EXPECTS: readonly string[] = ["allow", "ask", "deny"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isStringList(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

function checkEnvironment(env: unknown, where: string, errors: string[]): void {
  if (env === undefined) return;
  if (!isRecord(env)) {
    errors.push(`${where}: environment must be an object`);
    return;
  }
  for (const k of [
    "workspaceDirs",
    "gitRemotes",
    "trustedDomains",
    "productionMarkers",
  ]) {
    if (env[k] !== undefined && !isStringList(env[k])) {
      errors.push(`${where}: environment.${k} must be a list of strings`);
    }
  }
}

function checkCase(c: unknown, index: number, errors: string[]): void {
  if (!isRecord(c)) {
    errors.push(`cases[${index}]: not an object`);
    return;
  }
  const where = typeof c.id === "string" && c.id ? c.id : `cases[${index}]`;
  const bad = (msg: string) => errors.push(`${where}: ${msg}`);
  if (typeof c.id !== "string" || !c.id) bad("id is required");
  if (!POLICY_AREAS.includes(c.area as PolicyArea)) {
    bad(`area must be one of ${POLICY_AREAS.join(", ")}`);
  }
  if (typeof c.tool !== "string" || !c.tool) bad("tool is required");
  if (!isRecord(c.args)) bad("args must be an object");
  const h = c.history;
  if (!isRecord(h) || !isStringList(h.userMessages) || !h.userMessages.length) {
    bad("history.userMessages needs at least one message");
  } else if (h.toolCalls !== undefined && !Array.isArray(h.toolCalls)) {
    bad("history.toolCalls must be a list");
  }
  checkEnvironment(c.environment, where, errors);
  if (typeof c.expected !== "string" || !EXPECTS.includes(c.expected)) {
    bad("expected must be allow, ask or deny");
  }
  if (c.category !== undefined && !isModelCategory(c.category)) {
    bad(`unknown category ${String(c.category)}`);
  }
  if (c.expected === "allow" && c.category !== undefined) {
    bad("an allow case has no category");
  }
  if (typeof c.rationale !== "string" || !c.rationale.trim()) {
    bad("rationale is required (why this label is right)");
  }
  if (typeof c.floor !== "boolean") bad("floor must be true or false");
  if (c.floor === true && c.expected === "allow") {
    bad("a floor case cannot be expected to be allowed");
  }
}

/** Parse and validate a dataset. Throws one error listing every problem. */
export function parseDataset(
  text: string,
  format: "json" | "yaml" = "json",
): ReviewDataset {
  let raw: unknown;
  try {
    raw = format === "yaml" ? parseYaml(text) : JSON.parse(text);
  } catch (e) {
    throw new Error(
      `The dataset is not valid ${format}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(raw)) throw new Error("The dataset must be an object.");
  const errors: string[] = [];
  if (raw.version !== 1) errors.push("version must be 1");
  if (typeof raw.name !== "string" || !raw.name) {
    errors.push("name is required");
  }
  checkEnvironment(raw.environment, "dataset", errors);
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    errors.push("cases must be a non-empty list");
  } else {
    raw.cases.forEach((c, i) => checkCase(c, i, errors));
    const seen = new Set<unknown>();
    for (const c of raw.cases) {
      const id = isRecord(c) ? c.id : undefined;
      if (seen.has(id)) errors.push(`${String(id)}: duplicate id`);
      seen.add(id);
    }
  }
  if (errors.length) {
    throw new Error(`Invalid dataset:\n- ${errors.join("\n- ")}`);
  }
  return {
    ...(raw as unknown as ReviewDataset),
    environment: (raw.environment as CaseEnvironment | undefined) ?? {},
  };
}

/** The format a file name implies. */
export function datasetFormat(path: string): "json" | "yaml" {
  return /\.ya?ml$/i.test(path) ? "yaml" : "json";
}

export interface GuidanceFile {
  block?: string[];
  allow?: string[];
}

/**
 * Guidance text to try: JSON or YAML `{block: [...], allow: [...]}`, or plain
 * text where each line is a sentence (a leading "- " is dropped). A line that
 * reads "allow" or "fine to allow" (optionally a heading or ending in a colon)
 * starts the allow list; everything before it is block guidance.
 */
export function parseGuidance(text: string, path: string): GuidanceFile {
  if (/\.(json|ya?ml)$/i.test(path)) {
    const raw: unknown = /\.json$/i.test(path)
      ? JSON.parse(text)
      : parseYaml(text);
    if (!isRecord(raw)) throw new Error("The guidance file must be an object.");
    for (const k of ["block", "allow"]) {
      if (raw[k] !== undefined && !isStringList(raw[k])) {
        throw new Error(`guidance.${k} must be a list of strings`);
      }
    }
    return { block: raw.block as string[], allow: raw.allow as string[] };
  }
  const out: Required<GuidanceFile> = { block: [], allow: [] };
  let into: "block" | "allow" = "block";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^#*\s*(fine to )?allow\s*:?$/i.test(t)) into = "allow";
    else if (/^#*\s*(always )?(block|deny|ask)( for)?\s*:?$/i.test(t)) {
      into = "block";
    } else out[into].push(t.replace(/^[-*]\s+/, ""));
  }
  return out;
}
