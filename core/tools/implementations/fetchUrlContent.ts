import { ToolImpl } from ".";
import type { ContextItem } from "../..";
import { createSpotlight, type Spotlight } from "../permissions/spotlight";
import { getUrlContextItems } from "../../context/providers/URLContextProvider";
import { getStringArg } from "../parseArgs";
import { hostTrusted } from "../permissions/askProtections";
import { readUserTrustedDomains } from "../permissions/userTrustedDomains";

const DEFAULT_FETCH_URL_CHAR_LIMIT = 20000;

export const fetchUrlContentImpl: ToolImpl = async (args, extras) => {
  const url = getStringArg(args, "url");

  // A host the person trusts may be fetched without a review (B56), so it
  // cannot hand the request to a host they do not trust.
  const trusted = readUserTrustedDomains();
  let startHost = "";
  try {
    startHost = new URL(url).hostname;
  } catch {
    // the fetch below reports a bad URL
  }
  const confined = trusted.length > 0 && hostTrusted(startHost, trusted);

  const contextItems = await getUrlContextItems(url, extras.fetch, {
    guardRedirects: true,
    ...(confined
      ? { allowRedirectHost: (h: string) => hostTrusted(h, trusted) }
      : {}),
  });

  // Track truncated content
  const truncatedUrls: string[] = [];

  // Check and truncate each context item
  const processedItems = contextItems.map((item) => {
    if (item.content.length > DEFAULT_FETCH_URL_CHAR_LIMIT) {
      truncatedUrls.push(url);
      return {
        ...item,
        content: item.content.substring(0, DEFAULT_FETCH_URL_CHAR_LIMIT),
      };
    }
    return item;
  });

  // Add truncation warning if needed
  if (truncatedUrls.length > 0) {
    processedItems.push({
      name: "Truncation warning",
      description: "",
      content: `The content from ${truncatedUrls.join(", ")} was truncated because it exceeded the ${DEFAULT_FETCH_URL_CHAR_LIMIT} character limit. If you need more content, consider fetching specific sections or using a more targeted approach.`,
    });
  }

  return spotlightEnabled(extras.config?.experimental?.spotlightUntrusted)
    ? spotlightItems(processedItems, url)
    : processedItems;
};

/** Off unless the setting or CONTINUOUS_SPOTLIGHT_UNTRUSTED=1 says so. */
export function spotlightEnabled(setting: boolean | undefined): boolean {
  return setting === true || process.env.CONTINUOUS_SPOTLIGHT_UNTRUSTED === "1";
}

let session: Spotlight | undefined;

/**
 * Put each fetched page between the session's boundary markers, with the
 * sentence that explains them ahead of the first. Items that are not page
 * text (the truncation warning) are left as they are.
 */
export function spotlightItems(
  items: ContextItem[],
  source: string,
  spotlight: Spotlight = (session ??= createSpotlight()),
): ContextItem[] {
  let explained = false;
  return items.map((item) => {
    if (item.name === "Truncation warning") return item;
    const wrapped = spotlight.wrap(item.content, { source });
    const content = explained
      ? wrapped
      : `${spotlight.instruction}\n\n${wrapped}`;
    explained = true;
    return { ...item, content };
  });
}
