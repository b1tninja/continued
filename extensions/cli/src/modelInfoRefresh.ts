import {
  createOpenRouterRefresher,
  underTestRunner,
  type ModelCatalogRefresher,
} from "core/llm/modelCatalogRefresh.js";

import { userRequestOptions } from "./commands/models.js";
import { logger } from "./util/logger.js";

let refresher: ModelCatalogRefresher | undefined;

/**
 * Model information updates for the terminal agent, the same setting the
 * IDEs read (`modelCatalog:` in the user-level config.yaml, or
 * `CONTINUOUS_MODEL_INFO_UPDATES`). With `automatic` (the default) a stale
 * OpenRouter list is refreshed in the background: the first check runs one
 * to three seconds after start-up and later ones while the session lasts.
 * The timers do not keep the process alive and a run never waits for them;
 * a run that ends sooner simply makes no request.
 */
export function startModelInfoRefresh(
  create: typeof createOpenRouterRefresher = createOpenRouterRefresher,
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalogRefresher | undefined {
  if (refresher || underTestRunner(env)) return refresher;
  refresher = create({
    requestOptions: () => userRequestOptions() as never,
    log: (m) => logger.debug(m),
  });
  refresher.start({ delayMs: 1000, jitterMs: 2000 });
  return refresher;
}

export function stopModelInfoRefresh(): void {
  refresher?.stop();
  refresher = undefined;
}
