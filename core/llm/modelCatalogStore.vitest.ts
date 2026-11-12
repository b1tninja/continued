import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pullOpenRouterCatalog,
  readModelCatalogPolicy,
  readOpenRouterCatalog,
  writeOpenRouterCatalog,
} from "./modelCatalogStore";
import { MAX_CATALOG_BYTES } from "./openRouterCatalog";
import { sonnetEntry } from "./openRouterCatalogFixtures";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelcatalog-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stubFetch = (response: () => Response) => {
  const f = vi.fn(async () => response());
  vi.stubGlobal("fetch", f);
  return f;
};

describe("pullOpenRouterCatalog", () => {
  it("makes one GET to the public list, with no key or body, and writes a dated file", async () => {
    const f = stubFetch(
      () => new Response(JSON.stringify({ data: [sonnetEntry] })),
    );
    const file = path.join(dir, "model-catalog", "openrouter.json");
    const c = await pullOpenRouterCatalog(undefined, {
      file,
      now: () => new Date("2026-11-12T10:00:00Z"),
    });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init?.body).toBeUndefined();
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
    expect(c.fetchedAt).toBe("2026-11-12T10:00:00.000Z");

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toMatchObject({
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-12T10:00:00.000Z",
    });
    expect(readOpenRouterCatalog(file)?.models[0].pricing?.prompt).toBe(
      0.000003,
    );
    // no temporary files are left behind
    expect(fs.readdirSync(path.dirname(file))).toEqual(["openrouter.json"]);
  });

  it("keeps the older file when the request fails", async () => {
    const file = path.join(dir, "openrouter.json");
    stubFetch(() => new Response(JSON.stringify({ data: [sonnetEntry] })));
    await pullOpenRouterCatalog(undefined, { file });
    const before = fs.readFileSync(file, "utf8");
    stubFetch(() => new Response("down", { status: 503 }));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /503/,
    );
    stubFetch(() => new Response("<html>", { status: 200 }));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /did not return a model list/,
    );
    stubFetch(() => new Response(JSON.stringify({ data: [] })));
    await expect(pullOpenRouterCatalog(undefined, { file })).rejects.toThrow(
      /no models/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses an answer over the size cap", async () => {
    stubFetch(
      () => new Response("x".repeat(MAX_CATALOG_BYTES + 1), { status: 200 }),
    );
    await expect(
      pullOpenRouterCatalog(undefined, { file: path.join(dir, "o.json") }),
    ).rejects.toThrow(/size limit/);
  });
});

describe("readOpenRouterCatalog", () => {
  it("ignores a missing, corrupt, old-schema or oversize file", () => {
    const file = path.join(dir, "openrouter.json");
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(file, "{not json");
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 0,
        source: "s",
        fetchedAt: "2026-11-01T00:00:00Z",
        models: [{ id: "a", name: "A" }],
      }),
    );
    expect(readOpenRouterCatalog(file)).toBeUndefined();
    fs.writeFileSync(file, " ".repeat(MAX_CATALOG_BYTES + 1));
    expect(readOpenRouterCatalog(file)).toBeUndefined();
  });

  it("round-trips a written catalogue", () => {
    const file = path.join(dir, "sub", "openrouter.json");
    const catalog = {
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-10T00:00:00.000Z",
      models: [{ id: "a/b", name: "B", supportsTools: false }],
    };
    writeOpenRouterCatalog(catalog, file);
    expect(readOpenRouterCatalog(file)).toEqual(catalog);
  });
});

describe("readModelCatalogPolicy", () => {
  const yaml = (value: string) =>
    `name: x\nversion: 1\nmodelCatalog: ${value}\n`;

  it("reads modelCatalog from config.yaml, else the stand-in file, else ask", () => {
    const file = path.join(dir, "config.yaml");
    const standIn = path.join(dir, "policy.json");
    expect(readModelCatalogPolicy(file, standIn)).toBe("ask");
    fs.writeFileSync(standIn, JSON.stringify({ modelCatalog: "never" }));
    expect(readModelCatalogPolicy(file, standIn)).toBe("never");
    fs.writeFileSync(file, yaml("ask"));
    expect(readModelCatalogPolicy(file, standIn)).toBe("ask");
    fs.writeFileSync(file, yaml("never"));
    fs.rmSync(standIn);
    expect(readModelCatalogPolicy(file, standIn)).toBe("never");
    fs.writeFileSync(file, yaml("sometimes"));
    expect(readModelCatalogPolicy(file, standIn)).toBe("ask");
  });
});
