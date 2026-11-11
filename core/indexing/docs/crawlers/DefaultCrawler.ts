import { URL } from "node:url";

import { getHeaders } from "../../../continueServer/stubs/headers";
const TRIAL_PROXY_URL = "https://proxy-server-blue-l6vsfbzhba-uw.a.run.app";
import type { RequestOptions } from "../../..";
import { networkFetch } from "../../../util/networkFetch";

import { PageData } from "./DocsCrawler";

export class DefaultCrawler {
  constructor(
    private readonly startUrl: URL,
    private readonly maxRequestsPerCrawl: number,
    private readonly maxDepth: number,
    private readonly requestOptions?: RequestOptions,
  ) {}

  async crawl(): Promise<PageData[]> {
    const resp = await networkFetch(
      new URL("crawl", TRIAL_PROXY_URL).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getHeaders()),
        },
        body: JSON.stringify({
          startUrl: this.startUrl.toString(),
          maxDepth: this.maxDepth,
          limit: this.maxRequestsPerCrawl,
        }),
      },
      this.requestOptions,
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to crawl site (${resp.status}): ${text}`);
    }
    const json = (await resp.json()) as PageData[];
    return json;
  }
}
