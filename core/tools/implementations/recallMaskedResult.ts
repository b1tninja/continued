import { ToolImpl } from ".";
import { recallMasked } from "../../util/contextAgeing";
import { getStringArg } from "../parseArgs";

/**
 * Returns the body of a result that history ageing replaced with a stub. The
 * body comes from this process's recall store, filled when the result was
 * masked (util/contextAgeing.ts).
 */
export const recallMaskedResultImpl: ToolImpl = async (args) => {
  const handle = getStringArg(args, "handle").trim();
  return [
    {
      name: "Recalled tool result",
      description: handle,
      content: recallMasked(handle),
    },
  ];
};
