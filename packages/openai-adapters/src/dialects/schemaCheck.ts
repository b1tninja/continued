import type { DialectTool, RecoveredCall, RepairNote } from "./qwenXml.js";

type Schema = {
  properties?: Record<string, { type?: string | string[] } | undefined>;
  required?: string[];
};

function schemaOf(tool: DialectTool): Schema {
  return tool.parameters && typeof tool.parameters === "object"
    ? (tool.parameters as Schema)
    : {};
}

/** Whether `value` is of the JSON type(s) a schema declares; no type fits all. */
export function typeFits(
  value: unknown,
  type: string | string[] | undefined,
): boolean {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0) return true;
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return !!value && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

/** A number written the one way JSON.stringify would write it. */
function canonicalNumber(text: string): number | undefined {
  const n = Number(text);
  return Number.isFinite(n) && String(n) === text ? n : undefined;
}

/**
 * The value a string stands for when the schema declares a type it is an
 * exact literal of, else undefined. The one rule every dialect shares, so
 * `"timeout": "10"` means the same thing in all of them:
 *
 * - only integer, number, boolean, array and object targets; a parameter that
 *   may be a string (or declares no type) keeps its text, whatever it looks like;
 * - integer and number take the canonical spelling only (`10`, `-3`, `0.5`):
 *   not `10abc`, `1e3`, `010`, `1.0`, `+1` or the empty string;
 * - boolean takes exactly `true` or `false`;
 * - array and object take JSON text that parses to that type.
 */
export function coerceString(
  value: string,
  type: string | string[] | undefined,
): unknown {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length === 0 || types.includes("string")) return undefined;
  if (types.includes("integer") || types.includes("number")) {
    const n = canonicalNumber(value);
    if (n !== undefined) {
      if (types.includes("number") || Number.isSafeInteger(n)) return n;
    }
  }
  if (types.includes("boolean")) {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (types.includes("array") || types.includes("object")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        (Array.isArray(parsed) && types.includes("array")) ||
        (!!parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          types.includes("object"))
      ) {
        return parsed;
      }
    } catch {
      // not JSON: stays refused
    }
  }
  return undefined;
}

/**
 * `value` as the schema declares it: itself when it already fits, the value a
 * string stands for when it is an exact literal of the declared type
 * (`coerceString`, flagged `repaired`), else undefined when it cannot fit.
 * The single coercion every dialect parser uses.
 */
export function coerceToSchema(
  value: unknown,
  type: string | string[] | undefined,
): { value: unknown; repaired: boolean } | undefined {
  if (typeFits(value, type)) return { value, repaired: false };
  if (typeof value !== "string") return undefined;
  const coerced = coerceString(value, type);
  return coerced === undefined ? undefined : { value: coerced, repaired: true };
}

/** The note a coercion leaves on the recovered call. */
export function repairNote(
  argument: string,
  from: string,
  to: unknown,
): RepairNote {
  return { kind: "string-to-literal", argument, from, to };
}

/**
 * The recovered call of `tool` with arguments `args`, every value as the
 * schema declares it, or undefined when the call is not valid: an undeclared
 * key, a value that cannot be made to fit, a missing required key. A string
 * made into the literal it spells (`coerceToSchema`) is listed in `repairs`.
 */
export function fittedCall(
  tool: DialectTool,
  args: Record<string, unknown>,
  raw: string,
): RecoveredCall | undefined {
  const schema = schemaOf(tool);
  const out: Record<string, unknown> = {};
  const repairs: RepairNote[] = [];
  for (const [key, arg] of Object.entries(args)) {
    if (schema.properties && !(key in schema.properties)) return undefined;
    const fit = coerceToSchema(arg, schema.properties?.[key]?.type);
    if (!fit) return undefined;
    out[key] = fit.value;
    if (fit.repaired) repairs.push(repairNote(key, arg as string, fit.value));
  }
  if (!(schema.required ?? []).every((key) => key in args)) return undefined;
  return {
    name: tool.name,
    arguments: out,
    raw,
    ...(repairs.length > 0 ? { repairs } : {}),
  };
}

/** The declared JSON type(s) of one argument, when the schema gives them. */
export function declaredType(
  tool: DialectTool,
  key: string,
): string | string[] | undefined {
  return schemaOf(tool).properties?.[key]?.type;
}
