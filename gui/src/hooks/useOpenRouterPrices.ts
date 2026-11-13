import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";
import { useContext, useEffect } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

/**
 * Gives the cost figures in this window the OpenRouter prices downloaded
 * earlier (a file read in core, never a request to the network), so the usage
 * readouts can price those models and label the figure with the list's date.
 */
export function useOpenRouterPrices(): void {
  const ideMessenger = useContext(IdeMessengerContext);
  useEffect(() => {
    let cancelled = false;
    void ideMessenger
      .request("modelCatalog/cached", undefined)
      .then((res) => {
        if (cancelled || res.status !== "success" || !res.content) return;
        setOpenRouterCatalog({
          schemaVersion: 1,
          source: "https://openrouter.ai/api/v1/models",
          fetchedAt: res.content.fetchedAt,
          models: res.content.models,
        });
      })
      .catch(() => {
        // No prices for those models: tokens only, as before
      });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);
}
