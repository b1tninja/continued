import * as fs from "fs";
import { dirname } from "node:path";
import * as path from "path";

import {
  AssistantUnrolled,
  PackageIdentifier,
  RegistryClient,
  unrollAssistant,
  unrollAssistantFromContent,
} from "@continuedev/config-yaml";
import chalk from "chalk";

import { uriToPath } from "./auth/uriUtils.js";
import type { AuthConfig } from "./auth/workos.js";
import {
  getAccessToken,
  getOrganizationId,
  updateConfigUri,
} from "./auth/workos.js";
import { CLIPlatformClient } from "./CLIPlatformClient.js";
import { env } from "./env.js";
import { loadLocalModelFiles } from "./localModelFiles.js";

const HUB_UNSUPPORTED =
  "hub assistants are not supported; pass a config.yaml path";

export interface ConfigLoadResult {
  config: AssistantUnrolled;
  source: ConfigSource;
}

export type ConfigSource =
  | { type: "cli-flag"; path: string }
  | { type: "saved-uri"; uri: string }
  | { type: "local-config-yaml" }
  | { type: "no-config" };

/**
 * Streamlined configuration loader that implements the specification
 * with clear precedence and fallback logic in a single testable function.
 */
export async function loadConfiguration(
  authConfig: AuthConfig,
  cliConfigPath: string | undefined,
  injectBlocks: PackageIdentifier[],
  isHeadless: boolean | undefined,
): Promise<ConfigLoadResult> {
  const organizationId = getOrganizationId(authConfig);
  const accessToken = getAccessToken(authConfig);

  // Step 1: Determine config source using precedence rules
  const configSource = determineConfigSource(
    authConfig,
    cliConfigPath,
    isHeadless,
  );

  // Step 2: Load configuration from the determined source
  const config = await loadFromSource(
    configSource,
    accessToken,
    organizationId ?? null,
    injectBlocks,
  );

  // Step 3: Save config URI for session continuity
  const uri = getUriFromSource(configSource);
  if (uri) {
    updateConfigUri(uri);
  }

  return { config, source: configSource };
}

/**
 * Determines the configuration source using the specification's precedence rules:
 * 1. CLI --config flag (highest priority)
 * 2. Saved config URI (if no CLI flag)
 * 3. Default resolution (if no flag and no saved URI)
 */
function determineConfigSource(
  authConfig: AuthConfig,
  cliConfigPath: string | undefined,
  _isHeadless: boolean | undefined,
): ConfigSource {
  // Priority 1: CLI --config flag
  if (cliConfigPath) {
    return { type: "cli-flag", path: cliConfigPath };
  }

  // Priority 2: Check for default config.yaml, then fallback to default config
  const defaultConfigPath = path.join(env.continueHome, "config.yaml");
  if (fs.existsSync(defaultConfigPath)) {
    return { type: "local-config-yaml" };
  }

  // No hosted default config is fetched: a first run with nothing configured
  // uses an empty local assistant and makes no connection.
  return { type: "no-config" };
}

/**
 * Loads configuration from the determined source with appropriate error handling
 */
async function loadFromSource(
  source: ConfigSource,
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  try {
    switch (source.type) {
      case "cli-flag":
        return await loadFromCliFlag(
          source.path,
          accessToken,
          organizationId,
          injectBlocks,
        );

      case "saved-uri":
        return await loadFromSavedUri(
          source.uri,
          accessToken,
          organizationId,
          injectBlocks,
        );

      case "local-config-yaml":
        return await loadLocalConfigYaml(
          accessToken,
          organizationId,
          injectBlocks,
        );

      // TODO this is currently skipped because we are forcing default config
      // Because models add on won't work for injected blocks e.g. default model, (only default config)
      case "no-config":
        return await unrollPackageIdentifiersAsConfigYaml(
          injectBlocks,
          accessToken,
          organizationId,
        );
      default:
        throw new Error(`Unknown config source type: ${(source as any).type}`);
    }
  } catch (error) {
    throw error;
  }
}

/**
 * Loads configuration from CLI --config flag
 * Only file paths are supported
 */
async function loadFromCliFlag(
  configPath: string,
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  if (isFilePath(configPath)) {
    // Load local YAML file
    return await loadConfigYaml(
      configPath,
      accessToken,
      organizationId,
      injectBlocks,
    );
  }
  throw new Error(HUB_UNSUPPORTED);
}

/**
 * Loads configuration from saved URI in auth config
 */
async function loadFromSavedUri(
  uri: string,
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  const filePath = uriToPath(uri);
  if (filePath) {
    return await loadConfigYaml(
      filePath,
      accessToken,
      organizationId,
      injectBlocks,
    );
  }

  if (uri.startsWith("slug://")) {
    throw new Error(HUB_UNSUPPORTED);
  }

  throw new Error(`Invalid saved config URI: ${uri}`);
}

/**
 * Loads default config.yaml from the global folder (~/.continuous/config.yaml)
 */
async function loadLocalConfigYaml(
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  const defaultConfigPath = path.join(env.continueHome, "config.yaml");
  return await loadConfigYaml(
    defaultConfigPath,
    accessToken,
    organizationId,
    injectBlocks,
  );
}

export async function unrollPackageIdentifiersAsConfigYaml(
  packageIdentifiers: PackageIdentifier[],
  _accessToken: string | null,
  _organizationId: string | null,
): Promise<AssistantUnrolled> {
  const unrollResult = await unrollAssistantFromContent(
    {
      uriType: "file",
      fileUri: "",
    },
    "name: Agent\nschema: v1\nversion: 0.0.1",
    new RegistryClient({
      rootPath: undefined, // TODO verify this doesn't cause issues with file blocks
    }),
    {
      currentUserSlug: "",
      platformClient: new CLIPlatformClient(),
      renderSecrets: true,
      injectBlocks: packageIdentifiers,
      ...loadLocalModelFiles(),
    },
  );
  if (unrollResult.errors) {
    const fatalError = unrollResult.errors?.find((e) => e.fatal);
    if (fatalError) {
      throw new Error(`Failed to load config: ${fatalError.message}`);
    }
  }
  if (!unrollResult?.config) {
    throw new Error(`Failed to load config`);
  }

  return unrollResult.config;
}

async function unrollAssistantWithConfig(
  packageIdentifier: PackageIdentifier,
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  const unrollResult = await unrollAssistant(
    packageIdentifier,
    new RegistryClient({
      rootPath:
        packageIdentifier.uriType === "file"
          ? dirname(packageIdentifier.fileUri)
          : undefined,
    }),
    {
      currentUserSlug: "",
      alwaysUseProxy: false,
      renderSecrets: true,
      platformClient: new CLIPlatformClient(),
      injectBlocks,
      // Accounts (providers.yaml) and the model catalog (models.yaml)
      ...loadLocalModelFiles(),
    },
  );

  const errorDetails = unrollResult.errors;
  if (!unrollResult.config) {
    throw new Error(`Failed to load config:\n${errorDetails}`);
  } else if (errorDetails?.length) {
    const warnings =
      errorDetails?.length > 1
        ? errorDetails.map((d) => `\n- ${d.message}`)
        : errorDetails[0].message;
    console.warn(chalk.dim(`Warning: ${warnings}`));
  }

  return unrollResult.config;
}

/**
 * Loads a local YAML configuration file
 */
async function loadConfigYaml(
  filePath: string,
  accessToken: string | null,
  organizationId: string | null,
  injectBlocks: PackageIdentifier[],
): Promise<AssistantUnrolled> {
  return await unrollAssistantWithConfig(
    { fileUri: filePath, uriType: "file" },
    accessToken,
    organizationId,
    injectBlocks,
  );
}

/**
 * Determines if a config path is a file path (not a hub slug)
 */
function isFilePath(configPath: string): boolean {
  return (
    configPath.startsWith(".") ||
    configPath.startsWith("/") ||
    configPath.startsWith("~") ||
    // Windows absolute paths (C:\, D:\, etc.)
    /^[A-Za-z]:[/\\]/.test(configPath) ||
    // UNC paths (\\server\share)
    configPath.startsWith("\\\\") ||
    // Contains file extension
    configPath.includes(".yaml") ||
    configPath.includes(".yml") ||
    configPath.includes(".json")
  );
}

/**
 * Converts a config source back to a URI for persistence
 */
function getUriFromSource(source: ConfigSource): string | null {
  switch (source.type) {
    case "cli-flag":
      return `file://${source.path}`;
    case "saved-uri":
      return source.uri;
    case "local-config-yaml":
      return `file://${path.join(env.continueHome, "config.yaml")}`;
    default:
      return null;
  }
}
