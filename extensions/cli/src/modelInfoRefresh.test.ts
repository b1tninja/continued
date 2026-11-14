import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createOpenRouterRefresher,
  STARTUP_DELAY_MS,
} from "core/llm/modelCatalogRefresh.js";
import { readModelCatalogSettings } from "core/llm/modelCatalogStore.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startModelInfoRefresh,
  stopModelInfoRefresh,
} from "./modelInfoRefresh.js";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

const HOUR = 60 * 60 * 1000;

describe("startModelInfoRefresh", () => {
  afterEach(() => stopModelInfoRefresh());

  it("does not start under a test runner", () => {
    const create = vi.fn();
    expect(
      startModelInfoRefresh(create as never, { VITEST: "true" }),
    ).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("starts once per process, with a short start-up delay and without blocking", () => {
    const start = vi.fn();
    const create = vi.fn(() => ({ start, stop: vi.fn() }));
    const r = startModelInfoRefresh(create as never, {});
    expect(r).toBeDefined();
    expect(start).toHaveBeenCalledWith({ delayMs: 1000, jitterMs: 2000 });
    startModelInfoRefresh(create as never, {});
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("terminal agent parity: the shared setting", () => {
  let dir: string;
  let urls: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-model-info-"));
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "a/b",
                name: "B",
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          }),
        );
      }),
    );
    vi.useFakeTimers({ now: Date.parse("2026-11-13T12:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = async (configYaml: string, env: NodeJS.ProcessEnv = {}) => {
    const config = path.join(dir, "config.yaml");
    fs.writeFileSync(config, configYaml);
    const r = createOpenRouterRefresher({
      file: path.join(dir, "openrouter.json"),
      settings: () =>
        readModelCatalogSettings(config, path.join(dir, "none.json"), env),
    });
    r.start({ delayMs: 1000, jitterMs: 2000 });
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 48 * HOUR);
    r.stop();
    return urls.length;
  };

  it("automatic (default, no line in config.yaml): fetches a missing list", async () => {
    expect(await run("name: x\nversion: 1\n")).toBeGreaterThanOrEqual(1);
    expect(urls.every((u) => new URL(u).host === "openrouter.ai")).toBe(true);
  });

  it("modelCatalog: manual never fetches automatically", async () => {
    expect(await run("name: x\nversion: 1\nmodelCatalog: manual\n")).toBe(0);
  });

  it("modelCatalog: off never fetches", async () => {
    expect(await run("name: x\nversion: 1\nmodelCatalog: off\n")).toBe(0);
  });

  it("CONTINUOUS_MODEL_INFO_UPDATES=off overrides config.yaml", async () => {
    expect(
      await run("name: x\nversion: 1\nmodelCatalog: automatic\n", {
        CONTINUOUS_MODEL_INFO_UPDATES: "off",
      }),
    ).toBe(0);
  });
});
