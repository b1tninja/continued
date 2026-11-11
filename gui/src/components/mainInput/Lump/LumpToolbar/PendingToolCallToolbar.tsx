import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { Button } from "../../../ui";
import { useMainEditor } from "../../TipTapEditor";
import { AlwaysAllowButton } from "./AlwaysAllowButton";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const jetbrains = isJetBrains();
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const editor = useMainEditor();

  if (pendingToolCalls.length === 0) {
    return null;
  }

  const handleAccept = (toolCallId: string) => {
    void dispatch(callToolById({ toolCallId }));
  };

  const handleReject = (toolCallId: string) => {
    // put cursor in editor after last rejection
    if (pendingToolCalls.length === 1) {
      editor.mainEditor?.commands.focus();
    }
    void dispatch(cancelToolCallThunk({ toolCallId }));
  };

  return (
    <div className="flex w-full flex-col pb-0.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 px-1 pb-0.5">
        <span className="min-w-0 basis-full text-2xs text-description xs:basis-auto">
          Sending a new message cancels{" "}
          {pendingToolCalls.length > 1 ? "these commands" : "this command"}.
        </span>
        {pendingToolCalls.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="my-0 font-medium"
            onClick={() =>
              pendingToolCalls.forEach((t) => handleAccept(t.toolCallId))
            }
            data-testid="accept-all-tool-calls"
          >
            Accept all ({pendingToolCalls.length})
          </Button>
        )}
      </div>
      {pendingToolCalls.map((toolCall, index) => (
        <div
          key={toolCall.toolCallId}
          className="flex flex-wrap items-center gap-x-2 rounded-sm border border-input bg-input"
        >
          <span className="min-w-0 flex-1 basis-24 truncate text-xs text-description italic">
            {toolCall.tool?.displayTitle ?? toolCall.toolCall.function.name}
          </span>
          {toolCall.policyNote && (
            <span
              className="max-w-56 truncate text-2xs text-warning"
              title={maskCommandForDisplay(toolCall.policyNote)}
              data-testid={`policy-note-${toolCall.toolCallId}`}
            >
              {maskCommandForDisplay(toolCall.policyNote)}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-1">
            {!isJetBrains() && (
              <AlwaysAllowButton
                toolCallId={toolCall.toolCallId}
                toolName={toolCall.toolCall.function.name}
                parsedArgs={toolCall.parsedArgs}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              className="my-0.5 min-h-6 font-medium text-description"
              title="Reject this command"
              onClick={() => handleReject(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "reject",
                toolCall.toolCallId,
              )}
            >
              {/* JetBrains overrides cmd+backspace, so we have to use another shortcut */}
              {index === 0 && (
                <span className="mr-1 shrink-0 text-2xs" aria-hidden="true">
                  {jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}⌫
                </span>
              )}
              <span>Reject</span>
            </Button>

            <Button
              variant="primary"
              size="sm"
              className="my-0.5 min-h-6 font-medium"
              title="Run this command"
              onClick={() => handleAccept(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "accept",
                toolCall.toolCallId,
              )}
            >
              {index === 0 && (
                <span className="mr-1 shrink-0 text-2xs" aria-hidden="true">
                  {getMetaKeyLabel()}⏎
                </span>
              )}
              <span>Accept</span>
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
