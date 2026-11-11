import { expect, test, vi } from "vitest";

import { contextProviderClassFromName } from ".";
import {
  fetchSearchResults,
  getWebSearchBackend,
  isWebSearchConfigured,
} from "./webSearchBackend";

test("no backend unless the URL is set to http(s)", () => {
  expect(getWebSearchBackend({})).toBeUndefined();
  expect(
    getWebSearchBackend({ CONTINUOUS_WEB_SEARCH_URL: " " }),
  ).toBeUndefined();
  expect(
    getWebSearchBackend({ CONTINUOUS_WEB_SEARCH_URL: "ftp://x.example/s" }),
  ).toBeUndefined();
  expect(isWebSearchConfigured({ CONTINUOUS_WEB_SEARCH_URL: "nope" })).toBe(
    false,
  );
});

test("@web is hidden by default", () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
  expect(contextProviderClassFromName("web")).toBeUndefined();
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://s.example.org/search");
  expect(contextProviderClassFromName("web")).toBeDefined();
  vi.unstubAllEnvs();
});

test("queries only the configured endpoint, key as bearer, no identifying headers", async () => {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: "A", url: "https://a.example/", content: "aa" },
        { title: "B", url: "https://b.example/", content: "bb" },
      ],
    }),
  }));
  const backend = getWebSearchBackend({
    CONTINUOUS_WEB_SEARCH_URL: "https://s.example.org/search",
    CONTINUOUS_WEB_SEARCH_KEY: "k",
  });
  const items = await fetchSearchResults("hello", 1, fetchFn as any, backend);
  expect(items).toEqual([
    { name: "A", description: "https://a.example/", content: "aa" },
  ]);
  const [url, init] = fetchFn.mock.calls[0] as any;
  expect(url.origin).toBe("https://s.example.org");
  expect(url.searchParams.get("q")).toBe("hello");
  expect(Object.keys(init.headers).sort()).toEqual(["Accept", "Authorization"]);
});

test("throws when not configured and on HTTP errors", async () => {
  await expect(
    fetchSearchResults("q", 1, vi.fn() as any, undefined),
  ).rejects.toThrow(/not configured/);
  const backend = getWebSearchBackend({
    CONTINUOUS_WEB_SEARCH_URL: "https://s.example.org/search",
  });
  const bad = vi.fn(async () => ({
    ok: false,
    status: 500,
    text: async () => "boom",
  }));
  await expect(fetchSearchResults("q", 1, bad as any, backend)).rejects.toThrow(
    /500/,
  );
});
