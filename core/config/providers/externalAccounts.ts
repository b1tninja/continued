import type { CatalogModel, ProviderInstance } from "@continuedev/config-yaml";

/**
 * Accounts (and the catalog models they serve) that an IDE supplies from
 * its own settings: in VS Code, the groups a user adds for Continued in the
 * Language Models editor. They live in memory only, so their keys, which
 * the IDE keeps in its secret storage, are never written to a file.
 *
 * providers.yaml and models.yaml stay the source: a file entry with the
 * same name wins.
 */
export interface ExternalAccount {
  account: ProviderInstance;
  models: CatalogModel[];
}

const external = new Map<string, ExternalAccount>();

/**
 * Set, replace (same account name) or, with no account, remove one
 * external account. Returns whether anything changed, so the caller
 * reloads the config only then.
 */
export function setExternalAccount(
  name: string,
  value: ExternalAccount | undefined,
): boolean {
  const before = JSON.stringify(external.get(name));
  if (value) external.set(name, value);
  else external.delete(name);
  return JSON.stringify(external.get(name)) !== before;
}

export function externalProviderInstances(): ProviderInstance[] {
  return Array.from(external.values(), (e) => e.account);
}

export function externalCatalogModels(): CatalogModel[] {
  return Array.from(external.values()).flatMap((e) => e.models);
}

/** For tests. */
export function clearExternalAccounts() {
  external.clear();
}
