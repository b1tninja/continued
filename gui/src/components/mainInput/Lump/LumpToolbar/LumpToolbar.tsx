import { BuiltInToolNames } from "core/tools/builtIn";
import { useContext, useEffect } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import {
  selectFirstPendingToolCall,
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../../../../redux/selectors/selectToolCalls";
import { cancelToolCall } from "../../../../redux/slices/sessionSlice";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelStream } from "../../../../redux/thunks/cancelStream";
import { logToolUsage } from "../../../../redux/util";
import { isJetBrains } from "../../../../util";
import { useMainEditor } from "../../TipTapEditor";
import { BlockSettingsTopToolbar } from "./BlockSettingsTopToolbar";
import { EditOutcomeToolbar } from "./EditOutcomeToolbar";
import { EditToolbar } from "./EditToolbar";
import { IsApplyingToolbar } from "./IsApplyingToolbar";
import { PendingApplyStatesToolbar } from "./PendingApplyStatesToolbar";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";
import { StreamingToolbar } from "./StreamingToolbar";
import { TtsActiveToolbar } from "./TtsActiveToolbar";

// Keyboard shortcut detection utilities
const isExecuteToolCallShortcut = (event: KeyboardEvent) => {
  const metaKey = event.metaKey || event.ctrlKey;
  return metaKey && event.key === "Enter";
};

const isCancelToolCallShortcut = (
  event: KeyboardEvent,
  isJetBrains: boolean,
) => {
  const metaKey = event.metaKey || event.ctrlKey;
  const altKey = event.altKey;
  const modifierKey = isJetBrains ? altKey : metaKey;
  return modifierKey && event.key === "Backspace";
};

// Check if a tool call is a terminal command
const isTerminalCommand = (toolCallState: any) => {
  return (
    toolCallState?.toolCall?.function?.name ===
    BuiltInToolNames.RunTerminalCommand
  );
};

export type LumpToolbarKind =
  | "applying"
  | "edit-outcome"
  | "edit"
  | "tts"
  | "terminal"
  | "streaming"
  | "pending-tool-calls"
  | "pending-apply"
  | "idle";

/**
 * Which toolbar the row above the input shows. One place decides, in priority
 * order, so the row's neighbours (the session controls) can tell whether the
 * toolbar is a single line that sits beside them or a block that needs the
 * full width.
 */
export function useLumpToolbarKind(): LumpToolbarKind {
  const ttsActive = useAppSelector((state) => state.ui.ttsActive);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const editApplyStatus = useAppSelector(
    (state) => state.editModeState.applyState.status,
  );
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const hasRunningTerminalCommand = useAppSelector(
    (state) =>
      selectToolCallsByStatus(state, "calling").filter(isTerminalCommand)
        .length > 0,
  );

  if (applyStates.some((state) => state.status === "streaming")) {
    return "applying";
  }
  if (isInEdit) return editApplyStatus === "done" ? "edit-outcome" : "edit";
  if (ttsActive) return "tts";
  if (hasRunningTerminalCommand) return "terminal";
  if (isStreaming) return "streaming";
  if (pendingToolCalls.length > 0) return "pending-tool-calls";
  if (applyStates.some((state) => state.status === "done")) {
    return "pending-apply";
  }
  return "idle";
}

/** Kinds that are one line and can share the row with the session controls. */
export function isInlineToolbarKind(kind: LumpToolbarKind): boolean {
  return kind === "idle" || kind === "streaming" || kind === "terminal";
}

export function LumpToolbar() {
  const kind = useLumpToolbarKind();
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const jetbrains = isJetBrains();
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const firstPendingToolCall = useAppSelector(selectFirstPendingToolCall);
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const pendingApplyStates = applyStates.filter(
    (state) => state.status === "done",
  );
  const editor = useMainEditor();

  // Get ALL running terminal commands
  const runningToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "calling"),
  );
  const runningTerminalCalls = runningToolCalls.filter(isTerminalCommand);
  const hasRunningTerminalCommand = runningTerminalCalls.length > 0;

  // Simple handler: stop ALL running terminal commands
  const handleStopAllTerminalCommands = async () => {
    if (runningTerminalCalls.length === 0) {
      return;
    }

    // Stop all terminal commands concurrently
    const stopPromises = runningTerminalCalls.map(async (terminalCall) => {
      try {
        // Cancel the process on the backend
        await ideMessenger.request("process/killTerminalProcess", {
          toolCallId: terminalCall.toolCallId,
        });

        // Cancel the tool call in the UI
        dispatch(
          cancelToolCall({
            toolCallId: terminalCall.toolCallId,
          }),
        );

        logToolUsage(terminalCall, false, true, ideMessenger);
      } catch (error) {
        console.error(
          `Failed to cancel terminal command ${terminalCall.toolCallId}:`,
          error,
        );
      }
    });

    // Wait for all cancellations to complete
    await Promise.all(stopPromises);
  };

  // Combined stop handler
  const handleStopAction = async () => {
    // Stop all terminal commands if any are running
    if (hasRunningTerminalCommand) {
      await handleStopAllTerminalCommands();
    }

    // Also stop regular streaming if it's happening
    if (isStreaming) {
      dispatch(cancelStream());
    }
  };

  useEffect(() => {
    if (!firstPendingToolCall && !hasRunningTerminalCommand) {
      return;
    }

    const handleToolCallKeyboardShortcuts = (event: KeyboardEvent) => {
      if (isExecuteToolCallShortcut(event) && firstPendingToolCall) {
        event.preventDefault();
        event.stopPropagation();

        void dispatch(
          callToolById({ toolCallId: firstPendingToolCall.toolCallId }),
        );
      } else if (isCancelToolCallShortcut(event, jetbrains)) {
        event.preventDefault();
        event.stopPropagation();

        if (hasRunningTerminalCommand) {
          // Stop running terminal commands
          void handleStopAction();
        } else if (firstPendingToolCall) {
          // Cancel pending tool call. If last call, focus editor
          if (pendingToolCalls.length === 1) {
            editor.mainEditor?.commands.focus();
          }
          void dispatch(
            cancelToolCallThunk({
              toolCallId: firstPendingToolCall.toolCallId,
            }),
          );
          logToolUsage(firstPendingToolCall, false, true, ideMessenger);
        }
      }
    };

    document.addEventListener("keydown", handleToolCallKeyboardShortcuts);
    return () => {
      document.removeEventListener("keydown", handleToolCallKeyboardShortcuts);
    };
  }, [
    firstPendingToolCall,
    pendingToolCalls,
    editor,
    hasRunningTerminalCommand,
    runningTerminalCalls,
  ]);

  switch (kind) {
    case "applying":
      return <IsApplyingToolbar />;
    case "edit-outcome":
      return <EditOutcomeToolbar />;
    case "edit":
      return <EditToolbar />;
    case "tts":
      return <TtsActiveToolbar />;
    case "terminal": {
      const count = runningTerminalCalls.length;
      const stopText = `Stop Terminal${count > 1 ? ` (${count})` : ""}`;
      return (
        <StreamingToolbar onStop={handleStopAction} displayText={stopText} />
      );
    }
    case "streaming":
      return <StreamingToolbar onStop={() => dispatch(cancelStream())} />;
    case "pending-tool-calls":
      return <PendingToolCallToolbar />;
    case "pending-apply":
      return (
        <PendingApplyStatesToolbar pendingApplyStates={pendingApplyStates} />
      );
    default:
      return <BlockSettingsTopToolbar />;
  }
}
