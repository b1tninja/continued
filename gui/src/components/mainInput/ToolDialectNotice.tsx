import { useContext, useState } from "react";
import { leakNoticeText } from "core/util/toolDialectLeak";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { dismissToolDialectNotice } from "../../redux/slices/sessionSlice";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/**
 * Shown once per model per session when a reply carried a tool call written as
 * text. It only asks: the action sets `toolDialect` for that model in
 * config.yaml, and nothing is turned on until it is clicked.
 */
export function ToolDialectNotice() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const notices = useAppSelector((s) => s.session.toolDialectNotices);
  const [failed, setFailed] = useState<string>();

  const entry = Object.entries(notices ?? {}).find(([, n]) => !n.dismissed);
  if (!entry) return null;
  const [model, { dialect }] = entry;

  async function turnOn() {
    const res = await ideMessenger.request("config/setToolDialect", {
      title: model,
      toolDialect: dialect,
    });
    if (res.status === "success" && res.content.saved) {
      dispatch(dismissToolDialectNotice(model));
    } else {
      setFailed(
        `Could not edit the config. Add \`toolDialect: ${dialect}\` to this model in config.yaml.`,
      );
    }
  }

  return (
    <NoticeBar
      testId="tool-dialect-notice"
      onDismiss={() => dispatch(dismissToolDialectNotice(model))}
    >
      <span>{failed ?? leakNoticeText(dialect)}</span>
      {!failed && (
        <NoticeAction
          testId="tool-dialect-turn-on"
          title={`Sets toolDialect: ${dialect} on this model in config.yaml`}
          onClick={() => void turnOn()}
        >
          Turn on recovery
        </NoticeAction>
      )}
    </NoticeBar>
  );
}
