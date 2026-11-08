import { createAsyncThunk } from "@reduxjs/toolkit";
import { planBuildMessage } from "core/util/planFile";
import { findUriInDirs } from "core/util/uri";
import { setMode, setTaskPlan } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { streamResponseThunk } from "./streamResponse";

/** The path shown to the model: workspace-relative when it can be. */
async function displayPath(
  fileUri: string,
  getWorkspaceDirs: () => Promise<string[]>,
): Promise<string> {
  try {
    const { relativePathOrBasename, foundInDir } = findUriInDirs(
      fileUri,
      await getWorkspaceDirs(),
    );
    return foundInDir ? relativePathOrBasename : fileUri;
  } catch {
    return fileUri;
  }
}

/**
 * Build on a plan card: switch to Agent mode and send the message that tells
 * the model to implement the plan. Agent mode keeps no checklist, so the
 * planning list is cleared; "Build in a loop" is what works item by item.
 */
export const buildPlan = createAsyncThunk<
  void,
  { planFile: string },
  ThunkApiType
>("plan/build", async ({ planFile }, { dispatch, extra }) => {
  const ide = extra.ideMessenger.ide;
  dispatch(setTaskPlan(undefined));
  dispatch(setMode("agent"));

  const text = planBuildMessage(
    await displayPath(planFile, () => ide.getWorkspaceDirs()),
  );
  await dispatch(
    streamResponseThunk({
      editorState: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      modifiers: { noContext: true, useCodebase: false },
    }),
  );
});
