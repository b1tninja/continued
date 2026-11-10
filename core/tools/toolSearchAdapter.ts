import { Tool } from "..";
import { BUILT_IN_GROUP_NAME } from "./builtIn";
import { ToolAdapter } from "./toolSearch";

/** selectTools over the IDE's `Tool` shape. */
export const coreToolAdapter: ToolAdapter<Tool> = {
  name: (t) => t.function.name,
  description: (t) => t.function.description ?? "",
  parameters: (t) => t.function.parameters,
  isCore: (t) => t.group === BUILT_IN_GROUP_NAME,
};
