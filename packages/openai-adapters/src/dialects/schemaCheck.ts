import { typeFits } from "./pythonic.js";
import type { DialectTool } from "./qwenXml.js";

type Schema = {
  properties?: Record<string, { type?: string | string[] } | undefined>;
  required?: string[];
};

/**
 * Whether `args` is a valid argument object for `tool`: every key declared,
 * every value of the declared type, every required key present. The check
 * every strict dialect applies before it accepts a call.
 */
export function argumentsFit(
  tool: DialectTool,
  args: Record<string, unknown>,
): boolean {
  const schema: Schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Schema)
      : {};
  for (const [key, arg] of Object.entries(args)) {
    if (schema.properties && !(key in schema.properties)) return false;
    if (!typeFits(arg, schema.properties?.[key]?.type)) return false;
  }
  return (schema.required ?? []).every((key) => key in args);
}

/** The declared JSON type(s) of one argument, when the schema gives them. */
export function declaredType(
  tool: DialectTool,
  key: string,
): string | string[] | undefined {
  const schema = tool.parameters as Schema | undefined;
  return schema?.properties?.[key]?.type;
}
