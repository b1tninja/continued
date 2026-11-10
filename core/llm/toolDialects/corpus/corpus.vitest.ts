import { describe, expect, it } from "vitest";
import {
  decodeStream,
  loadCorpus,
  loadRawCorpus,
  validateFixture,
  type CorpusFixture,
} from "./corpus";

describe("the tool dialect corpus", () => {
  const raw = loadRawCorpus();

  it("has fixtures and every one passes the schema", () => {
    expect(raw.length).toBeGreaterThanOrEqual(60);
    for (const { file, raw: fixture } of raw) {
      expect(validateFixture(fixture), file).toEqual([]);
    }
  });

  it("names each file after the fixture id and keeps ids unique", () => {
    const ids = raw.map(({ raw: f }) => (f as CorpusFixture).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { file, raw: f } of raw) {
      expect(file).toBe(`${(f as CorpusFixture).id}.json`);
    }
  });

  it("records provenance on every fixture and keeps observed honest", () => {
    const corpus = loadCorpus();
    for (const f of corpus) {
      expect(f.provenance.source.length, f.id).toBeGreaterThan(0);
      expect(f.provenance.retrieved, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (f.flag === "observed") {
        expect(f.provenance.source, f.id).toMatch(/^https:\/\//);
        expect(f.provenance.reportDate, f.id).toBeTruthy();
      }
    }
    const observed = corpus.filter((f) => f.flag === "observed").length;
    expect(observed).toBeGreaterThan(0);
    expect(observed).toBeLessThan(corpus.length);
  });

  it("covers the families, with a negative set", () => {
    const corpus = loadCorpus();
    const families = new Set(corpus.map((f) => f.family));
    for (const family of [
      "qwen3-coder",
      "qwen3-hermes",
      "glm-4.x",
      "deepseek-v3.x",
      "deepseek-v3.2",
      "kimi-k2",
      "gpt-oss",
      "llama-3.x",
      "llama-4",
      "mistral",
      "gemma-4",
      "minimax-m2",
      "amazon-nova",
    ]) {
      expect(families.has(family), family).toBe(true);
    }
    expect(
      corpus.filter((f) => f.kind === "negative").length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("splits streams inside a marker and inside a multi-byte character", () => {
    const corpus = loadCorpus();
    const labels = new Set(
      corpus.flatMap((f) => f.streams.map((s) => s.label)),
    );
    for (const label of [
      "whole",
      "char",
      "inside-marker",
      "inside-multibyte-char",
      "random-1-5",
    ]) {
      expect(labels.has(label), label).toBe(true);
    }
  });

  it("decodes every stream back to the text, partial characters included", () => {
    for (const f of loadCorpus()) {
      for (const s of f.streams) {
        expect(decodeStream(s).join(""), `${f.id}/${s.label}`).toBe(f.text);
      }
    }
  });

  it("rejects fixtures that break the rules", () => {
    const good = loadCorpus()[0];
    const bad = (patch: Record<string, unknown>) =>
      validateFixture({ ...good, ...patch });
    expect(bad({ provenance: undefined })).not.toEqual([]);
    expect(
      bad({
        flag: "observed",
        provenance: { ...good.provenance, source: "synthesised from x" },
      }),
    ).not.toEqual([]);
    expect(bad({ flag: "maybe" })).not.toEqual([]);
    expect(
      bad({ streams: [{ ...good.streams[0], chunks: ["x"] }] }),
    ).not.toEqual([]);
    expect(bad({ expected: { calls: [], text: "" } })).not.toEqual([]);
  });
});
