import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";

import { BaseContextProvider } from "../";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  FetchFunction,
  RequestOptions,
} from "../../index.js";
import { fetchFavicon } from "../../util/fetchFavicon";
import { fetchWithGuardedRedirects } from "../../util/guardedFetch";

class URLContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "url",
    displayTitle: "URL",
    description: "Reference a webpage at a given URL",
    type: "query",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    return await getUrlContextItems(query, extras.fetch, {
      requestOptions: extras.config?.requestOptions,
    });
  }
}

export default URLContextProvider;

export interface UrlFetchOptions {
  /**
   * For URLs chosen by the model (the fetch tool) rather than typed by the
   * user: follow redirects one at a time and refuse one that leads from a
   * public address to a non-public one (loopback, private network, the cloud
   * metadata address), and skip the favicon lookup, which would fetch another
   * URL from the page. A URL that is itself non-public is the caller's
   * decision (the tool asks for approval first).
   */
  guardRedirects?: boolean;
  /** For the favicon lookup, which does not go through `fetchFn`. */
  requestOptions?: RequestOptions;
}

export async function getUrlContextItems(
  query: string,
  fetchFn: FetchFunction,
  options: UrlFetchOptions = {},
): Promise<ContextItem[]> {
  const url = new URL(query);
  const icon = options.guardRedirects
    ? undefined
    : await fetchFavicon(url, options.requestOptions);
  const resp = options.guardRedirects
    ? await fetchWithGuardedRedirects(url, fetchFn)
    : await fetchFn(url);

  // Check if the response is not OK
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();

  const dom = new JSDOM(html);
  let reader = new Readability(dom.window.document);
  let article = reader.parse();
  const content = article?.content || "";
  const markdown = NodeHtmlMarkdown.translate(
    content,
    {},
    undefined,
    undefined,
  );

  const title = article?.title || url.pathname;

  return [
    {
      icon,
      description: url.toString(),
      content: markdown,
      name: title,
      uri: {
        type: "url",
        value: url.toString(),
      },
    },
  ];
}
