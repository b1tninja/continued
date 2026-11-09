import { loopAutonomy } from "core/util/loopMode";
import { useEffect, useRef, useState } from "react";
import { useStore } from "react-redux";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { RootState } from "../redux/store";
import { selectCurrentToolCalls } from "../redux/selectors/selectToolCalls";
import { selectLoopPolicy } from "../redux/selectors/selectAutoApproval";
import { advanceLoop, syncLoopPolicy } from "../redux/thunks/loop";

/**
 * Runs Loop mode: whenever the loop is active and nothing is going on (no
 * stream, no tool call being generated, run or waiting, no message of the
 * person's about to be sent), take the next step. One step at a time: a step
 * resolves when the turn it started ends, and the next check follows.
 */
export function useLoopDriver() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const loopStatus = useAppSelector((s) => s.session.loop?.status);
  const loopCurrent = useAppSelector((s) => s.session.loop?.current);
  // A wave's workers finish by themselves; the step after the last one
  // starts what is next
  const loopParallel = useAppSelector((s) => s.session.loop?.parallel);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const toolBusy = useAppSelector((s) =>
    selectCurrentToolCalls(s).some(
      (tc) =>
        tc.status === "generating" ||
        tc.status === "generated" ||
        tc.status === "calling",
    ),
  );
  // The person's own queued messages go first, as at any turn end
  const personQueued = useAppSelector(
    (s) =>
      !s.session.isQueuePaused &&
      s.session.queuedMessages.some((m) => !m.loopAnswerId),
  );
  // Unattended: when the wait for answers runs out, take a step anyway
  const waitingSince = useAppSelector((s) => s.session.loop?.waitingSince);
  const hasLoop = useAppSelector((s) => !!s.session.loop);
  // The Plan edits and Questions levels the loop follows
  const policyKey = useAppSelector((s) => JSON.stringify(selectLoopPolicy(s)));
  const busy = useRef(false);
  const [tick, setTick] = useState(0);

  const active = loopStatus === "running" || loopStatus === "replanning";
  const ready = active && !isStreaming && !toolBusy && !personQueued;

  useEffect(() => {
    if (!ready || busy.current) return;
    busy.current = true;
    const before = store.getState().session.loop;
    void dispatch(advanceLoop()).finally(() => {
      busy.current = false;
      // Check again only if the step changed something, so a step that has
      // nothing to do cannot spin
      if (store.getState().session.loop !== before) setTick((t) => t + 1);
    });
  }, [ready, loopCurrent, loopParallel, tick, dispatch, store]);

  useEffect(() => {
    if (loopStatus !== "waiting" || !waitingSince) return;
    const wait = loopAutonomy(store.getState().session.loop!).waitTimeoutMs;
    if (wait <= 0) return;
    const due = new Date(waitingSince).getTime() + wait - Date.now();
    const timer = setTimeout(
      () => {
        if (busy.current) return;
        busy.current = true;
        void dispatch(advanceLoop()).finally(() => {
          busy.current = false;
          setTick((t) => t + 1);
        });
      },
      Math.max(0, due),
    );
    return () => clearTimeout(timer);
  }, [loopStatus, waitingSince, policyKey, dispatch, store]);

  // Moving Plan edits or Questions in the toolbar changes the running loop
  useEffect(() => {
    if (hasLoop) void dispatch(syncLoopPolicy());
  }, [hasLoop, policyKey, dispatch]);
}
