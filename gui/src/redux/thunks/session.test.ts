import { Session } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession, setLoadingSessionId } from "../slices/sessionSlice";
import { setupStore } from "../store";
import { loadLastSession, loadSession, resumeInitialSession } from "./session";

function savedSession(sessionId: string, title = "Saved"): Session {
  return {
    sessionId,
    title,
    workspaceDirectory: "",
    history: [
      {
        message: { id: `${sessionId}-m1`, role: "user", content: "hi" },
        contextItems: [],
      },
    ],
  } as unknown as Session;
}

/** A store whose `history/load` waits until the test releases it. */
function setup() {
  const messenger = new MockIdeMessenger();
  const pending = new Map<
    string,
    { resolve: (s: Session) => void; reject: (e: Error) => void }
  >();
  messenger.responseHandlers["history/load"] = ({ id }) =>
    new Promise<Session>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  const store = setupStore({ ideMessenger: messenger });
  const release = (id: string, session = savedSession(id)) =>
    pending.get(id)!.resolve(session);
  const fail = (id: string) => pending.get(id)!.reject(new Error("gone"));
  const waitForRequest = async (id: string) => {
    for (let i = 0; i < 50 && !pending.has(id); i++) {
      await Promise.resolve();
    }
    expect(pending.has(id)).toBe(true);
  };
  return { store, release, fail, waitForRequest };
}

describe("loadSession", () => {
  it("marks the session as loading until it arrives", async () => {
    const { store, release, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    expect(store.getState().session.loadingSessionId).toBe("a");

    release("a");
    await done;
    const { session } = store.getState();
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.id).toBe("a");
    expect(session.history).toHaveLength(1);
  });

  it("drops the load if the user starts a new session first", async () => {
    const { store, release, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    store.dispatch(newSession());
    const freshId = store.getState().session.id;

    release("a");
    await done;
    const { session } = store.getState();
    expect(session.id).toBe(freshId);
    expect(session.history).toEqual([]);
    expect(session.loadingSessionId).toBeUndefined();
  });

  it("keeps only the most recently requested session", async () => {
    const { store, release, waitForRequest } = setup();
    const first = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    const second = store.dispatch(
      loadSession({ sessionId: "b", saveCurrentSession: false }),
    );
    await waitForRequest("b");

    release("b");
    await second;
    release("a");
    await first;
    expect(store.getState().session.id).toBe("b");
  });

  it("clears the loading mark when the load fails", async () => {
    const { store, fail, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    fail("a");
    const result = await done;
    expect(result.meta.requestStatus).toBe("rejected");
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });

  it("does not clear a newer load when an older one fails", async () => {
    const { store, fail, waitForRequest } = setup();
    const first = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    store.dispatch(setLoadingSessionId("b"));
    fail("a");
    await first;
    expect(store.getState().session.loadingSessionId).toBe("b");
  });
});

describe("loadLastSession", () => {
  it("drops the load if the user starts a new session first", async () => {
    const { store, release, waitForRequest } = setup();
    store.dispatch(newSession(savedSession("prev")));
    store.dispatch(newSession()); // lastSessionId is now "prev"
    const done = store.dispatch(loadLastSession());
    await waitForRequest("prev");
    expect(store.getState().session.loadingSessionId).toBe("prev");

    store.dispatch(newSession());
    const freshId = store.getState().session.id;
    release("prev");
    await done;
    expect(store.getState().session.id).toBe(freshId);
  });
});

describe("resumeInitialSession", () => {
  it("loads the session when nothing has changed", async () => {
    const { store, release, waitForRequest } = setup();
    const id = store.getState().session.id;
    store.dispatch(setLoadingSessionId(id));
    const done = store.dispatch(resumeInitialSession(id));
    await waitForRequest(id);
    release(id);
    await done;
    expect(store.getState().session.history).toHaveLength(1);
  });

  it("skips when the user already started a new session", async () => {
    const { store } = setup();
    const id = store.getState().session.id;
    store.dispatch(newSession());
    const freshId = store.getState().session.id;
    await store.dispatch(resumeInitialSession(id));
    expect(store.getState().session.id).toBe(freshId);
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });

  it("skips when another session is being loaded", async () => {
    const { store } = setup();
    const id = store.getState().session.id;
    store.dispatch(setLoadingSessionId("other"));
    await store.dispatch(resumeInitialSession(id));
    expect(store.getState().session.loadingSessionId).toBe("other");
  });

  it("skips when the session already has history", async () => {
    const { store } = setup();
    store.dispatch(newSession(savedSession("a")));
    await store.dispatch(resumeInitialSession("a"));
    expect(store.getState().session.history).toHaveLength(1);
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });
});
