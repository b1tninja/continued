import { Logger } from "../util/Logger.js";

/**
 * Close context providers that hold resources (database pools) before a
 * config reload drops them.
 */
export async function closeContextProviders(
  providers: { close?: () => unknown }[] | undefined,
): Promise<void> {
  for (const provider of providers ?? []) {
    if (typeof provider?.close !== "function") continue;
    try {
      await provider.close();
    } catch (err) {
      Logger.error(err, { context: "context_provider_close" });
    }
  }
}
