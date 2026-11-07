import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearDanglingMessages,
  setInactive,
  setQueuePaused,
  setSteeredMessages,
} from "../slices/sessionSlice";
import { interruptLoop } from "core/util/loopMode";
import { ThunkApiType } from "../store";
import { commitLoop } from "../util/loopCommit";

export const cancelStream = createAsyncThunk<void, undefined, ThunkApiType>(
  "chat/cancelStream",
  async (messages, { dispatch, extra, getState }) => {
    dispatch(setInactive());
    dispatch(abortStream());
    // Whoever stopped the agent decides what to send next
    if (getState().session.queuedMessages?.length) {
      dispatch(setQueuePaused(true));
      dispatch(setSteeredMessages([]));
    }

    // Stop during Loop mode stops the loop too; the item goes back to pending
    const loop = getState().session.loop;
    if (loop?.current) {
      commitLoop(dispatch, getState, interruptLoop(loop));
    }

    // Clear any dangling incomplete tool calls, thinking messages, etc.
    dispatch(clearDanglingMessages());
  },
);
