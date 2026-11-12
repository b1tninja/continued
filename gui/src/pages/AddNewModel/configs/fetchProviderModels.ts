import { ModelProviderTags } from "../../../components/modelSelection/utils";
import { IIdeMessenger } from "../../../context/IdeMessenger";
import { isLikelyChatModelId } from "../../../forms/modelListUtils";
import { ModelPackage } from "./models";
import { models } from "./models";
import { ollamaStaticModels, providers } from "./providers";

interface FetchedModel {
  name: string;
  modelId?: string;
  description?: string;
  icon?: string;
  contextLength?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  reasoningEfforts?: string[];
  server?: string;
  createdAt?: string;
  deprecated?: boolean;
}

function modelParams(model: FetchedModel): Record<string, any> {
  const params: Record<string, any> = {};
  if (model.contextLength) params.contextLength = model.contextLength;
  if (model.maxTokens) {
    params.completionOptions = { maxTokens: model.maxTokens };
  }
  // Saved as catalog variants, one per effort (see catalogEntryFor)
  if (model.reasoningEfforts && model.reasoningEfforts.length > 0) {
    params.reasoningEfforts = model.reasoningEfforts;
  }
  if (model.supportsTools || model.supportsImages) {
    params.capabilities = {
      ...(model.supportsTools ? { tools: true } : {}),
      ...(model.supportsImages ? { uploadImage: true } : {}),
    };
  }
  return params;
}

function toOllamaPackage(model: FetchedModel): ModelPackage {
  return {
    title: model.name,
    description: model.description || model.name,
    refUrl: `https://ollama.com/library/${model.name}`,
    params: {
      title: model.name,
      model: model.name,
      ...(model.supportsTools ? { capabilities: { tools: true } } : {}),
    },
    isOpenSource: true,
    tags: [ModelProviderTags.Local, ModelProviderTags.OpenSource],
    providerOptions: ["ollama"],
    icon: model.icon ?? "ollama.png",
  };
}

function toOpenRouterPackage(model: FetchedModel): ModelPackage {
  const id = model.modelId ?? model.name;
  return {
    title: model.name,
    description: model.name,
    refUrl: `https://openrouter.ai/models/${id}`,
    params: {
      title: model.name,
      model: id,
      ...modelParams(model),
    },
    isOpenSource: false,
    tags: [ModelProviderTags.RequiresApiKey],
    providerOptions: ["openrouter"],
    icon: model.icon ?? "openrouter.png",
  };
}

function toGenericPackage(model: FetchedModel, provider: string): ModelPackage {
  const id = model.modelId ?? model.name;
  return {
    title: model.name,
    description: model.description || id,
    params: {
      title: model.name,
      model: id,
      ...modelParams(model),
    },
    isOpenSource: false,
    providerOptions: [provider],
    ...(model.icon ? { icon: model.icon } : {}),
    ...(model.createdAt ? { createdAt: model.createdAt } : {}),
    ...(model.deprecated ? { deprecated: true } : {}),
    ...(model.server ? { server: model.server } : {}),
  };
}

async function fetchModels(
  ideMessenger: IIdeMessenger,
  provider: string,
  apiKey?: string,
  apiBase?: string,
): Promise<FetchedModel[]> {
  const response = await ideMessenger.request("models/fetch", {
    provider,
    apiKey,
    apiBase,
  });
  if (response.status === "error" || !response.content) {
    return [];
  }
  return response.content.sort((a, b) => a.name.localeCompare(b.name));
}

/** Checklist entries for the chat models in a fetched list. */
export function fetchedToPackages(
  models: FetchedModel[],
  provider: string,
): ModelPackage[] {
  return models
    .filter((m) => isLikelyChatModelId(m.modelId ?? m.name))
    .map((m) => toGenericPackage(m, provider));
}

export async function fetchProviderModels(
  ideMessenger: IIdeMessenger,
  provider: string,
  apiKey: string,
  apiBase?: string,
): Promise<ModelPackage[]> {
  const models = await fetchModels(ideMessenger, provider, apiKey, apiBase);
  return fetchedToPackages(models, provider);
}

/** Providers whose model catalogue is a public page on a third-party host. */
export const CATALOGUE_HOSTS: Record<string, string> = {
  ollama: "ollama.com",
  openrouter: "openrouter.ai",
};

/**
 * Providers whose catalogue prompt was answered (Download or Not now) in this
 * app session. Held in memory only; nothing is persisted.
 */
const answered = new Set<string>();
export const catalogueAnswered = (id: string) => answered.has(id);
export const markCatalogueAnswered = (id: string) => void answered.add(id);
const bundled = {
  ollama: providers.ollama?.packages,
  openrouter: providers.openrouter?.packages,
};
/** Forget the answers and the downloaded lists (the bundled lists return). */
export const resetCatalogueAnswers = () => {
  answered.clear();
  if (providers.ollama && bundled.ollama) {
    providers.ollama.packages = bundled.ollama;
  }
  if (providers.openrouter && bundled.openrouter) {
    providers.openrouter.packages = bundled.openrouter;
  }
};

/**
 * Fetch one provider's catalogue (Ollama or OpenRouter) and fold it into the
 * provider's list. This contacts a third-party host, so it runs only when the
 * user presses Refresh, never when the setup screen opens. Until then the
 * bundled list stays. Returns false (and changes nothing) when nothing came
 * back, e.g. offline.
 */
export async function refreshProviderCatalogue(
  ideMessenger: IIdeMessenger,
  providerId: string,
): Promise<boolean> {
  if (!CATALOGUE_HOSTS[providerId]) return false;
  let fetched: FetchedModel[];
  try {
    fetched = await fetchModels(ideMessenger, providerId);
  } catch {
    return false;
  }
  if (fetched.length === 0) return false;
  if (providerId === "ollama" && providers.ollama) {
    const popular = [
      {
        ...models.AUTODETECT,
        params: { ...models.AUTODETECT.params, title: "Ollama" },
      },
      ...ollamaStaticModels,
    ];
    const popularTitles = new Set(popular.map((p) => p.title));
    const additional = fetched
      .map(toOllamaPackage)
      .filter((p) => !popularTitles.has(p.title));
    providers.ollama.packages = [...popular, ...additional];
  } else if (providerId === "openrouter" && providers.openrouter) {
    providers.openrouter.packages = fetched.map(toOpenRouterPackage);
  }
  return true;
}
