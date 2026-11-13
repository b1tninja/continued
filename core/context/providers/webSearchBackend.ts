import { ContextItem, FetchFunction } from "../..";

/**
 * The web search backend is the user's own. Nothing is contacted unless
 * CONTINUOUS_WEB_SEARCH_URL names a SearXNG-compatible JSON search endpoint
 * (for example `https://search.example.org/search`). The request is
 * `GET <url>?q=<query>&format=json`; a reply of `{ "results": [{ "title",
 * "url", "content" }] }` is used. CONTINUOUS_WEB_SEARCH_KEY, if set, is sent
 * as a bearer token to that endpoint and nowhere else. With the URL unset the
 * `search_web` tool and the `@web` context provider are not offered.
 */
export const WEB_SEARCH_URL_ENV = "CONTINUOUS_WEB_SEARCH_URL";
export const WEB_SEARCH_KEY_ENV = "CONTINUOUS_WEB_SEARCH_KEY";

export interface WebSearchBackend {
  url: URL;
  apiKey?: string;
}

export function getWebSearchBackend(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchBackend | undefined {
  const raw = env[WEB_SEARCH_URL_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    const apiKey = env[WEB_SEARCH_KEY_ENV]?.trim();
    return { url, apiKey: apiKey ? apiKey : undefined };
  } catch {
    return undefined;
  }
}

export function isWebSearchConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getWebSearchBackend(env) !== undefined;
}

export const fetchSearchResults = async (
  query: string,
  n: number,
  fetchFn: FetchFunction,
  backend: WebSearchBackend | undefined = getWebSearchBackend(),
): Promise<ContextItem[]> => {
  if (!backend) {
    throw new Error(
      `Web search is not configured. Set ${WEB_SEARCH_URL_ENV} to your own search endpoint.`,
    );
  }
  const url = new URL(backend.url);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  const resp = await fetchFn(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Web search failed (${resp.status}): ${text}`);
  }
  const body = (await resp.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (body.results ?? []).slice(0, n).map((r) => ({
    name: r.title ?? r.url ?? "Search result",
    description: r.url ?? "",
    content: r.content ?? "",
  }));
};
