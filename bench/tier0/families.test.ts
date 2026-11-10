import { describe, expect, it } from "vitest";

import { FAMILY_RULES } from "../../core/llm/llms/bedrockFamilyRules";
import { findModelRow, loadMatrix } from "../src/common.mjs";
import {
  commandFor,
  loadProbes,
  mantleBase,
  requestsFor,
  resolveProbe,
} from "../probe.mjs";

/**
 * Tier 0 of the model benchmark for the Tier 1 definitions of the families not
 * yet measured (plans/model-families-2026-11.md): the declarative probes and
 * matrix rows are consistent, name only rows that exist, carry sources and
 * dates, and emit requests without sending any. Nothing here needs a provider.
 *
 * Run from extensions/cli: npx vitest run --dir ../../bench/tier0
 */
const doc = loadProbes();
const matrix = loadMatrix();

const NEW_ROWS = [
  "kimi-k3",
  "kimi-k31",
  "kimi-k2-thinking",
  "kimi-k25",
  "grok46",
  "glm5",
  "minimax-m25",
  "nemotron3-super",
  "gpt-oss-120b",
];

describe("the probe definitions", () => {
  it("cover every family the roadmap lists as unmeasured", () => {
    const rows = Object.values(doc.families).map((f: any) => f.row);
    for (const row of NEW_ROWS) expect(rows, row).toContain(row);
  });

  it("name matrix rows that exist, and probes that exist", () => {
    for (const [id, fam] of Object.entries<any>(doc.families)) {
      expect(() => findModelRow(matrix, fam.row), id).not.toThrow();
      for (const p of fam.probes)
        expect(() => resolveProbe(doc, p), id).not.toThrow();
    }
  });

  it("give every family a source URL, a read date and the unprobed status", () => {
    for (const [id, fam] of Object.entries<any>(doc.families)) {
      expect(fam.status, id).toBe("unprobed");
      expect(String(fam.read), id).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(fam.sources.length, id).toBeGreaterThan(0);
      for (const url of fam.sources) expect(url, id).toMatch(/^https:\/\//);
    }
  });

  it("expand every family into requests with its own model id, and send nothing", () => {
    for (const id of Object.keys(doc.families)) {
      const { row, requests, family } = requestsFor(doc, id, matrix);
      expect(requests.length, id).toBeGreaterThan(3);
      for (const req of requests) {
        const key = family.route === "converse" ? "modelId" : "model";
        expect(req.body[key], `${id}/${req.name}`).toBe(row.model);
        expect(JSON.stringify(req.body)).not.toMatch(/AKIA|Bearer|apiKey/);
      }
    }
  });

  it("applies each reasoning variant to its own request only", () => {
    const { requests } = requestsFor(doc, "kimi-k3", matrix);
    const byName = Object.fromEntries(
      requests.map((r: any) => [r.name, r.body]),
    );
    expect(
      byName["reasoning-variant.effort-low"].additionalModelRequestFields,
    ).toEqual({ reasoning_effort: "low" });
    expect(
      byName["reasoning-variant.effort-max"].additionalModelRequestFields,
    ).toEqual({ reasoning_effort: "max" });
    expect(byName["baseline"].additionalModelRequestFields).toBeUndefined();
  });

  it("resolves a probe that builds on another", () => {
    const anyTool = resolveProbe(doc, "tool-any");
    expect(anyTool.converse.toolConfig.toolChoice).toEqual({ any: {} });
    // the tool spec is inherited from tool-auto
    expect(anyTool.converse.toolConfig.tools[0].toolSpec.name).toBe(
      "read_file",
    );
    expect(anyTool.chat.tool_choice).toBe("required");
  });

  it("keeps converse-only probes off the chat routes", () => {
    for (const id of [
      "gpt-oss-120b-mantle",
      "glm5-mantle",
      "minimax-m25-mantle",
    ]) {
      const names = requestsFor(doc, id, matrix).requests.map(
        (r: any) => r.probe,
      );
      expect(names).not.toContain("tool-stream");
      expect(names).not.toContain("replay-reasoning");
    }
  });

  it("writes aws commands for Converse and curl commands for Mantle", () => {
    const opts = { region: "us-east-1", profile: "p", base: "https://x/v1" };
    const conv = requestsFor(doc, "kimi-k3", matrix).requests;
    expect(commandFor(conv[0], opts)).toMatch(/^aws bedrock-runtime converse /);
    const stream = conv.find((r: any) => r.stream);
    expect(commandFor(stream, opts)).toMatch(/converse-stream/);
    const chat = requestsFor(doc, "glm5-mantle", matrix).requests;
    expect(commandFor(chat[0], opts)).toMatch(
      /^curl .*AWS_BEARER_TOKEN_BEDROCK/,
    );
  });

  it("puts Grok on the /openai/v1 path and the rest on /v1", () => {
    expect(mantleBase("us-west-2", "xai.grok-4.6")).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
    );
    expect(mantleBase("us-east-1", "openai.gpt-oss-120b")).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/v1",
    );
  });
});

describe("the matrix rows for the unmeasured families", () => {
  const rows = matrix.models.filter((r: any) =>
    [
      "kimi-k3",
      "kimi-k31",
      "kimi-k2-thinking",
      "grok46",
      "glm5",
      "minimax-m25",
      "nemotron3-super",
      "gpt-oss-120b-mantle",
      "glm5-mantle",
      "minimax-m25-mantle",
    ].includes(r.id),
  );

  it("exist, with their providers defined", () => {
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(matrix.providers[r.provider], r.id).toBeDefined();
    }
  });

  it("say unprobed, and use only effort writers the runner knows", () => {
    for (const r of rows) {
      expect(r.notes, r.id).toMatch(/^unprobed/);
      expect(["bedrock-reasoning", "openai-effort", "none"], r.id).toContain(
        r.effort,
      );
    }
  });

  it("only wire an effort switch where the request builder has one", () => {
    // Kimi K3 and K3.1 are the only Converse rows with a documented field
    const wired = rows
      .filter((r: any) => r.effort === "bedrock-reasoning")
      .map((r: any) => r.id);
    expect(wired.sort()).toEqual(["kimi-k3", "kimi-k31"]);
  });

  it("have a family rule in the request-builder table for every Converse family", () => {
    const ids = new Set(FAMILY_RULES.map((r) => r.id));
    for (const id of [
      "kimi-k3",
      "kimi-k2-thinking",
      "glm-5",
      "minimax-m2.5",
      "nemotron-3-super",
      "grok-4.6",
      "gpt-oss",
      "kimi-k2.5",
    ])
      expect(ids.has(id), id).toBe(true);
  });
});
