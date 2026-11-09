/**
 * Which optional request field a provider's validation error names as one the
 * model does not take. Part of the request-field policy (plans/ROADMAP.md
 * C58): a documented capability is decided from the tables before a request
 * is sent; when a provider still refuses a field that only changes cost, the
 * request is sent once more without it, the model is remembered for the
 * process, and the user is told with the config line that makes it permanent.
 * Fields that change the answer (tools, the system prompt) are never dropped
 * this way.
 *
 * Bedrock's texts, seen live (plans/cache-next-features.md, 2026-11-04):
 *  - "This model doesn't support the stopSequences field" (Qwen, newer Mistral,
 *    gpt-oss) and "This model doesn't support the cachePoint field" (GPT);
 *  - "extraneous key [cachePoint] is not permitted" (Nova, for a cache point
 *    in the tool list);
 *  - "the model or request does not allow prompt caching" (Grok).
 */
export type BedrockRefusableField = "stopSequences" | "cachePoint";

export function bedrockRefusedField(
  error: unknown,
): BedrockRefusableField | undefined {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as { message?: unknown } | undefined)?.message ?? "");
  const named = message.match(/doesn.t support the (\w+) field/i)?.[1];
  if (named === "stopSequences" || named === "cachePoint") return named;
  if (/does not allow prompt caching/i.test(message)) return "cachePoint";
  if (/extraneous key/i.test(message) && /cachePoint/i.test(message)) {
    return "cachePoint";
  }
  return undefined;
}

/**
 * A Converse request, loosely typed: the shape both Bedrock clients build.
 * Blocks are `object` so the SDK's union types fit without a cast.
 */
export interface ConverseRequestLike {
  inferenceConfig?: { stopSequences?: string[] };
  system?: object[];
  toolConfig?: { tools?: object[] };
  messages?: Array<{ content?: object[] }>;
}

/** Whether the request carries the field at all; a refusal of an absent field is some other error. */
export function converseRequestHasField(
  input: ConverseRequestLike,
  field: BedrockRefusableField,
): boolean {
  if (field === "stopSequences") {
    return !!input.inferenceConfig?.stopSequences?.length;
  }
  const hasPoint = (blocks?: object[]) =>
    !!blocks?.some((b) => "cachePoint" in b);
  return (
    hasPoint(input.system) ||
    hasPoint(input.toolConfig?.tools) ||
    !!input.messages?.some((m) => hasPoint(m.content))
  );
}

/** A copy of the request without the field: stop sequences dropped, or every cache point block removed. */
export function converseRequestWithoutField<T extends ConverseRequestLike>(
  input: T,
  field: BedrockRefusableField,
): T {
  if (field === "stopSequences") {
    return {
      ...input,
      inferenceConfig: { ...input.inferenceConfig, stopSequences: undefined },
    } as T;
  }
  const drop = <B extends object>(blocks?: B[]) =>
    blocks?.filter((b) => !("cachePoint" in b));
  return {
    ...input,
    ...(input.system && { system: drop(input.system) }),
    ...(input.toolConfig && {
      toolConfig: { ...input.toolConfig, tools: drop(input.toolConfig.tools) },
    }),
    ...(input.messages && {
      messages: input.messages.map((m) => ({ ...m, content: drop(m.content) })),
    }),
  } as T;
}
