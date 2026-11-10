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
