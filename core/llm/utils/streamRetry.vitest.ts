import { describe, expect, it } from "vitest";

import {
  isDroppedConnectionError,
  retryStreamOnDroppedConnection,
} from "./streamRetry";

const dropped = () =>
  Object.assign(
    new Error(
      "Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: aborted",
    ),
    { name: "FetchError", type: "system" },
  );

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("isDroppedConnectionError", () => {
  it("recognises node-fetch, undici and socket drops", () => {
    expect(isDroppedConnectionError(dropped())).toBe(true);
    expect(isDroppedConnectionError(new Error("terminated"))).toBe(true);
    expect(
      isDroppedConnectionError(
        Object.assign(new Error("read"), { code: "ECONNRESET" }),
      ),
    ).toBe(true);
    expect(
      isDroppedConnectionError(
        new Error(
          "Stream was closed before any data was received. Try again. (Premature Close)",
        ),
      ),
    ).toBe(true);
  });

  it("leaves user aborts and API errors alone", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isDroppedConnectionError(abort)).toBe(false);
    expect(
      isDroppedConnectionError(new Error("Anthropic API sent back 400")),
    ).toBe(false);
  });
});

describe("retryStreamOnDroppedConnection", () => {
  it("retries when the connection drops before anything arrived", async () => {
    let calls = 0;
    const result = await collect(
      retryStreamOnDroppedConnection(
        async function* () {
          calls++;
          if (calls < 3) throw dropped();
          yield "a";
          yield "b";
        },
        undefined,
        [0, 0],
      ),
    );
    expect(result).toEqual(["a", "b"]);
    expect(calls).toBe(3);
  });

  it("gives up after the retries with a readable error", async () => {
    let calls = 0;
    const run = collect(
      retryStreamOnDroppedConnection(
        async function* () {
          calls++;
          throw dropped();
        },
        undefined,
        [0, 0],
      ),
    );
    await expect(run).rejects.toThrow(
      /connection to api\.anthropic\.com closed before the response arrived \(tried 3 times\)/,
    );
    expect(calls).toBe(3);
  });

  it("does not replay a response that already started", async () => {
    let calls = 0;
    const seen: string[] = [];
    const run = (async () => {
      for await (const x of retryStreamOnDroppedConnection(
        async function* () {
          calls++;
          yield "partial";
          throw dropped();
        },
        undefined,
        [0, 0],
      )) {
        seen.push(x);
      }
    })();
    await expect(run).rejects.toThrow(/closed in the middle of the response/);
    expect(calls).toBe(1);
    expect(seen).toEqual(["partial"]);
  });

  it("passes other errors and user aborts straight through", async () => {
    const apiError = new Error("Anthropic API sent back 400");
    await expect(
      collect(
        retryStreamOnDroppedConnection(async function* () {
          throw apiError;
        }),
      ),
    ).rejects.toBe(apiError);

    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      collect(
        retryStreamOnDroppedConnection(
          async function* () {
            calls++;
            throw dropped();
          },
          controller.signal,
          [0, 0],
        ),
      ),
    ).rejects.toThrow(/Invalid response body/);
    expect(calls).toBe(1);
  });
});
