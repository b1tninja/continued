import type { ToolDialectSetting } from "./schemas/models.js";

/**
 * The request-body field and environment variable the Bedrock handlers read
 * to recover tool calls a model wrote as text. Same strings as
 * RECOVER_TEXT_TOOL_CALLS_FIELD / _ENV in packages/openai-adapters; this
 * package cannot import that one, and a test pins them equal.
 */
export const RECOVER_FIELD = "x_continue_recover_text_tool_calls";
export const RECOVER_ENV = "CONTINUE_RECOVER_TEXT_TOOL_CALLS";

/**
 * The recovery value a model's `toolDialect` stands for: the dialect to
 * recover (prefixed so it applies whatever the model is called), "" for
 * `native` and `off` (recovery off), undefined for `auto` or no setting.
 */
export function recoveryValueFor(
  toolDialect: ToolDialectSetting | undefined,
): string | undefined {
  switch (toolDialect) {
    case "qwen-xml":
    case "pythonic":
    case "llama-json":
    case "hermes-json":
    case "glm-xml":
    case "granite-tokens":
    case "lfm-tokens":
    case "hy3-tags":
    case "solar-tokens":
    case "longcat-json":
    case "olmo-function-calls":
    case "seed-xml":
    case "cohere-action":
      return `force:${toolDialect}`;
    case "native":
    case "off":
      return "";
    default:
      return undefined;
  }
}

/**
 * The extra body properties with the model's `toolDialect` applied. Nothing
 * changes when it is absent or `auto`, and the environment variable wins when
 * it is set (the field is then left out so the variable is read).
 */
export function withToolDialect(
  extraBody: Record<string, unknown> | undefined,
  toolDialect: ToolDialectSetting | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> | undefined {
  const value = recoveryValueFor(toolDialect);
  if (value === undefined) return extraBody;
  if (env[RECOVER_ENV]) {
    if (!extraBody || !(RECOVER_FIELD in extraBody)) return extraBody;
    const { [RECOVER_FIELD]: _dropped, ...rest } = extraBody;
    return rest;
  }
  return { ...extraBody, [RECOVER_FIELD]: value };
}

/** The environment, where there is one (the webview has none). */
function processEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * The recovery setting in force for a model: its `toolDialect` and the extra
 * body properties, then the environment variable (which wins, as
 * `withToolDialect` arranges). Exactly what the adapters' `recoverySetting`
 * reads from the body this produces, so everything that asks "is recovery on
 * for this model, and for which dialect" (the Bedrock handlers, tool enabling,
 * the bench) gets one answer. Undefined when nothing asks for recovery.
 */
export function effectiveRecoverySetting(
  toolDialect: ToolDialectSetting | undefined,
  extraBody?: Record<string, unknown>,
  env: Record<string, string | undefined> = processEnv(),
): string | undefined {
  const asked =
    withToolDialect(extraBody, toolDialect, env)?.[RECOVER_FIELD] ??
    env[RECOVER_ENV];
  return typeof asked === "string" ? asked : undefined;
}

/**
 * Whether a recovery setting (one name or a comma-separated list, each
 * optionally `force:`-prefixed) asks for `dialect`.
 */
export function recoverySettingAsks(
  setting: string | undefined,
  dialect: string,
): boolean {
  return (setting ?? "")
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === dialect || s === `force:${dialect}`);
}
