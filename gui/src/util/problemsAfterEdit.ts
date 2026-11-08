import { ContextItem, Problem } from "core";
import {
  newProblems,
  newProblemsItem,
  PROBLEMS_WAIT_MS,
} from "core/tools/problemsReport";
import { IIdeMessenger } from "../context/IdeMessenger";

/** Each edit's problems from before it was applied, by tool call id. */
const before = new Map<string, Promise<Problem[]>>();

async function problemsOf(
  ideMessenger: IIdeMessenger,
  filepath: string,
): Promise<Problem[]> {
  try {
    const response = await ideMessenger.request("getProblems", { filepath });
    return response.status === "success" ? response.content : [];
  } catch {
    return [];
  }
}

/** Call before applying an edit: remembers the file's current problems. */
export function rememberProblemsBeforeEdit(
  ideMessenger: IIdeMessenger,
  toolCallId: string,
  filepath: string,
) {
  before.set(toolCallId, problemsOf(ideMessenger, filepath));
}

/**
 * Call once the edit is accepted: waits for the language servers, then
 * returns the context item for problems the edit introduced, if any.
 */
export async function problemsAfterEdit(
  ideMessenger: IIdeMessenger,
  toolCallId: string,
  filepath: string,
): Promise<ContextItem | undefined> {
  const earlier = before.get(toolCallId);
  before.delete(toolCallId);
  if (!earlier) return undefined;
  try {
    const [was, now] = await Promise.all([
      earlier,
      ideMessenger
        .request("waitForProblems", { filepath, timeoutMs: PROBLEMS_WAIT_MS })
        .then((r) => (r.status === "success" ? r.content : [])),
    ]);
    return newProblemsItem(filepath, newProblems(was, now));
  } catch {
    return undefined;
  }
}
