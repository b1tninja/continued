import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { selectSelectedChatModel } from "../slices/configSlice";
import { ThunkApiType } from "../store";
import { addUserInputToHistory } from "./addUserInputToHistory";
import {
  ensureSessionEnvironment,
  needsSessionEnvironment,
} from "./sessionEnvironment";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async ({ editorState, modifiers, index }, { dispatch, extra, getState }) => {
    await dispatch(
      streamThunkWrapper(async () => {
        const state = getState();
        const selectedChatModel = selectSelectedChatModel(state);
        const inputIndex = index ?? state.session.history.length; // Either given index or concat to end

        if (!selectedChatModel) {
          throw new Error("No chat model selected");
        }
        // Before the turn's other work, so its order is the same with or
        // without the environment (core gathers it once per session)
        if (needsSessionEnvironment(getState())) {
          await ensureSessionEnvironment(
            getState,
            dispatch,
            extra.ideMessenger,
          );
        }
        const { legacyCommandWithInput, selectedContextItems, selectedCode } =
          await addUserInputToHistory({
            editorState,
            modifiers,
            index: inputIndex,
            dispatch,
            getState,
            ideMessenger: extra.ideMessenger,
          });

        unwrapResult(
          await dispatch(
            streamNormalInput({
              legacySlashCommandData: legacyCommandWithInput
                ? {
                    command: legacyCommandWithInput.command,
                    contextItems: selectedContextItems,
                    historyIndex: inputIndex,
                    input: legacyCommandWithInput.input,
                    selectedCode,
                  }
                : undefined,
            }),
          ),
        );
      }),
    );
  },
);
