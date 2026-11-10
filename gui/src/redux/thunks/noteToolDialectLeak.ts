import { renderChatMessage } from "core/util/messageContent";
import {
  detectToolDialectLeak,
  providerRecoversText,
} from "core/util/toolDialectLeak";
import { selectSelectedChatModel } from "../slices/configSlice";
import { noteToolDialectLeak } from "../slices/sessionSlice";
import type { AppDispatch, RootState } from "../store";

/**
 * After a reply: if the selected model wrote a tool call as text (outside any
 * code fence) and recovery is not set for it, record it so the notice shows
 * once. Warns only; nothing is changed here.
 */
export function checkToolDialectLeak(
  state: RootState,
  dispatch: AppDispatch,
): void {
  const model = selectSelectedChatModel(state);
  if (!model || !providerRecoversText(model.provider)) return;
  const last = state.session.history.at(-1)?.message;
  if (last?.role !== "assistant") return;
  const leak = detectToolDialectLeak({
    content: renderChatMessage(last),
    toolCalls: last.toolCalls?.map((c) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "",
    })),
    current: model.toolDialect,
  });
  if (leak) {
    dispatch(
      noteToolDialectLeak({ model: model.title, dialect: leak.dialect }),
    );
  }
}
