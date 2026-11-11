// Result schema v1 (MR8): the validator for bench/lab/schema/result.v1.schema.json.
// A small interpreter for the subset of JSON Schema the file uses (type, const,
// enum, required, properties, additionalProperties, pattern, minimum,
// minLength, local $ref), so no package is needed. Pure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RESULT_SCHEMA = JSON.parse(
  fs.readFileSync(
    path.join(HERE, "..", "schema", "result.v1.schema.json"),
    "utf8",
  ),
);

const typeOf = (v) =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : Number.isInteger(v)
        ? "integer"
        : typeof v;

const isType = (v, t) =>
  t === "number"
    ? typeof v === "number" && Number.isFinite(v)
    : typeOf(v) === t;

function walk(schema, root, value, at, out) {
  if (schema.$ref) {
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((o, k) => o?.[k], root);
    return walk(target, root, value, at, out);
  }
  if ("const" in schema && value !== schema.const)
    out.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value))
    out.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) {
      out.push(`${at}: must be ${types.join(" or ")}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength && value.length < schema.minLength)
      out.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      out.push(`${at}: does not match ${schema.pattern}`);
  }
  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  )
    out.push(`${at}: below ${schema.minimum}`);
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? [])
      if (!(k in value)) out.push(`${at}.${k}: required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) walk(props[k], root, v, `${at}.${k}`, out);
      else if (schema.additionalProperties === false)
        out.push(`${at}.${k}: not allowed`);
    }
  }
}

/** Problems with a result record, or [] when it conforms to schema v1. */
export function validateResult(record) {
  const out = [];
  walk(RESULT_SCHEMA, RESULT_SCHEMA, record, "$", out);
  return out;
}
