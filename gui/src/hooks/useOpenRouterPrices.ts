import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";
import { useContext, useEffect } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

/** How often the window looks for a newer list (a file read in core). */
export const PRICE_RELOAD_MS = 10 * 60 * 1000;

/**
 * Gives the cost figures in this window the OpenRouter prices downloaded
 * earlier (a file read in core, never a request to the network), so the usage
 * readouts can price those models and label the figure with the list's date.
 * Core may refresh the list in the background (model information updates
 * `automatic`), so the window reads it again now and then and takes the newer
 * copy when its date changed.
 */
export function useOpenRouterPrices(): void {
  const ideMessenger = useContext(IdeMessengerContext);
  useEffect(() => {
    let cancelled = false;
    let loadedAt: string | null | undefined;
    const load = () =>
      ideMessenger
        .request("modelCatalog/cached", undefined)
        .then((res) => {
          if (cancelled || res.status !== "success") return;
          const fetchedAt = res.content?.fetchedAt ?? null;
          if (fetchedAt === loadedAt) return;
          const hadList = typeof loadedAt === "string";
          loadedAt = fetchedAt;
          if (res.content) {
            setOpenRouterCatalog({
              schemaVersion: 1,
              source: "https://openrouter.ai/api/v1/models",
              fetchedAt: res.content.fetchedAt,
              models: res.content.models,
            });
          } else if (hadList) {
            // Updates were turned off: the bundled model data applies
            setOpenRouterCatalog(undefined);
          }
        })
        .catch(() => {
          // No prices for those models: tokens only, as before
        });
    void load();
    const timer = setInterval(() => void load(), PRICE_RELOAD_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ideMessenger]);
}
