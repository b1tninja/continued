/**
 * When a model has several routes (accounts serving the same model, see
 * `routes` in models.yaml), which failures move a request on to the next
 * route. Anything else (a bad request, a refusal, a tool error) would fail
 * the same way on every route, so it is reported as it is.
 */

const statusOf = (error: unknown): number | undefined => {
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    response?: { status?: unknown };
  };
  for (const v of [
    e?.status,
    e?.statusCode,
    e?.$metadata?.httpStatusCode,
    e?.response?.status,
  ]) {
    if (typeof v === "number") return v;
  }
  const m = /\b(4\d\d|5\d\d)\b/.exec(messageOf(error));
  return m ? Number(m[1]) : undefined;
};

const messageOf = (error: unknown): string => {
  const e = error as { message?: unknown; name?: unknown; code?: unknown };
  return [e?.name, e?.code, e?.message, typeof error === "string" ? error : ""]
    .filter((p) => typeof p === "string")
    .join(" ");
};

/** The account cannot be reached or does not accept the credentials. */
function isConnectionFailure(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 403) return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|UnrecognizedClientException|ExpiredToken|InvalidSignature|AccessDenied|CredentialsProviderError|Could not load credentials/i.test(
    messageOf(error),
  );
}

/** The account has the model but cannot serve it now, or does not offer it. */
function isUnavailable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 503 || status === 529) return true;
  return /Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady|ResourceNotFound|model.{0,40}(not (available|found|supported)|does not exist)|overloaded|rate limit/i.test(
    messageOf(error),
  );
}

/** The prompt does not fit the model's window on this account. */
export function isContextLengthError(error: unknown): boolean {
  return /context.{0,20}(length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds the (maximum|context)/i.test(
    messageOf(error),
  );
}

/**
 * Whether a failure on one route should be retried on the next: a
 * connection or authorization failure, the model not being available or
 * being throttled, or (only when the next route has a larger window) the
 * prompt not fitting.
 */
export function shouldTryNextRoute(
  error: unknown,
  current: { contextLength?: number },
  next: { contextLength?: number },
): boolean {
  if (isContextLengthError(error)) {
    return (next.contextLength ?? 0) > (current.contextLength ?? 0);
  }
  return isConnectionFailure(error) || isUnavailable(error);
}
