/**
 * A dropped connection while a streamed response is being read (node-fetch:
 * "Invalid response body while trying to fetch ...: aborted", undici:
 * "terminated", a premature close, ECONNRESET) never reaches the fetch-level
 * retry, which only sees the request. This retries the whole request when the
 * connection drops before anything was handed to the caller, and otherwise
 * replaces node-fetch's wording with one that says what happened.
 */

const RETRY_DELAYS_MS = [1000, 3000];

export function isDroppedConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string; message?: string };
  if (e.name === "AbortError") return false;
  if (
    e.code === "ECONNRESET" ||
    e.code === "EPIPE" ||
    e.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    e.code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const message = (e.message ?? "").toLowerCase();
  return (
    message.includes("invalid response body while trying to fetch") ||
    message.includes("premature close") ||
    message.includes("socket hang up") ||
    message === "terminated"
  );
}

function hostOf(error: unknown): string | undefined {
  const match = /trying to fetch (\S+?): /.exec(
    (error as { message?: string })?.message ?? "",
  );
  if (!match) return undefined;
  try {
    return new URL(match[1]).host;
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function* retryStreamOnDroppedConnection<T>(
  start: () => AsyncIterable<T>,
  signal?: AbortSignal,
  delaysMs: number[] = RETRY_DELAYS_MS,
): AsyncGenerator<T> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const chunk of start()) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (signal?.aborted || !isDroppedConnectionError(error)) throw error;

      if (!yielded && attempt < delaysMs.length) {
        console.warn(
          `Connection dropped before the response started; retrying (${attempt + 1}/${delaysMs.length}).`,
          error,
        );
        await sleep(delaysMs[attempt], signal);
        if (signal?.aborted) return;
        continue;
      }

      const host = hostOf(error);
      const where = host ? ` to ${host}` : "";
      const message = yielded
        ? `The connection${where} closed in the middle of the response, so the reply is incomplete. Resubmit to try again.`
        : `The connection${where} closed before the response arrived (tried ${attempt + 1} times). Check your network or proxy and resubmit.`;
      throw new Error(`${message} (${(error as Error).message})`, {
        cause: error,
      });
    }
  }
}
