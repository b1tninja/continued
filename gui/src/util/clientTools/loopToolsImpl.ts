import { ContinueError, ContinueErrorReason } from "core/util/errors";
import {
  finishItemReport,
  finishItemResult,
  holdQuestion,
  holdQuestionResult,
} from "core/util/loopMode";
import { commitLoop } from "../../redux/util/loopCommit";
import { ClientToolImpl } from "./callClientTool";

function runningItem(extras: Parameters<ClientToolImpl>[2]) {
  const loop = extras.getState().session.loop;
  if (!loop || loop.current?.kind !== "item" || !loop.current.itemId) {
    throw new ContinueError(
      ContinueErrorReason.Unspecified,
      "This tool is only for an item that Loop mode is running.",
    );
  }
  return { loop, itemId: loop.current.itemId };
}

/** hold_question: puts a question in the loop's inbox; the turn goes on. */
export const holdQuestionImpl: ClientToolImpl = async (
  args,
  _toolCallId,
  extras,
) => {
  const { loop, itemId } = runningItem(extras);
  const result = holdQuestion(
    loop,
    {
      itemId,
      question: args?.question,
      kind: args?.kind,
      assumption: args?.assumption,
    },
    new Date(),
  );
  if (!result.ok) {
    throw new ContinueError(ContinueErrorReason.Unspecified, result.error);
  }
  commitLoop(extras.dispatch, extras.getState, result.loop);
  return {
    respondImmediately: true,
    output: [
      {
        name: "Question held",
        description: `${result.question.id} (${result.question.kind})`,
        content: holdQuestionResult(result.question, result.duplicate),
        hidden: false,
      },
    ],
  };
};

/** finish_item: records the run's report and ends the turn. */
export const finishItemImpl: ClientToolImpl = async (
  args,
  _toolCallId,
  extras,
) => {
  const { loop } = runningItem(extras);
  const parsed = finishItemReport(args);
  if (!parsed.ok) {
    throw new ContinueError(ContinueErrorReason.Unspecified, parsed.error);
  }
  const { report } = parsed;
  commitLoop(extras.dispatch, extras.getState, {
    ...loop,
    current: loop.current && { ...loop.current, report },
  });
  return {
    respondImmediately: true,
    // The loop picks what comes next; no need to ask the model again
    endTurn: true,
    output: [
      {
        name: "Item reported",
        description: report.outcome,
        content: finishItemResult(report.outcome),
        hidden: false,
      },
    ],
  };
};
