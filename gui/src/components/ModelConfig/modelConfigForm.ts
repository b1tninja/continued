import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import {
  capabilitiesFor,
  capabilityState,
  getPath,
  MODEL_EDIT_FIELDS,
  pathKey,
  secretRef,
  SENSITIVE_HEADER,
  validateFieldValue,
  type CredentialState,
  type ModelEditField,
  type ModelPatchOp,
  type TriState,
} from "core/config/modelEdit/modelEditFields";
import { isValidSecretName } from "core/util/unresolvedSecrets";

/**
 * The dialog's state as the inputs hold it: text for text, number and list
 * fields ("" means the key is absent and the default applies), a tri-state
 * for booleans, a set for roles (null: absent, the default roles apply).
 */
export type BoolChoice = "default" | "on" | "off";

export interface HeaderRow {
  /** Stable key for React. */
  id: string;
  name: string;
  /** For a credential header this is "" until a new reference is typed. */
  value: string;
  /** The header existed and its value is a credential, so it was withheld. */
  withheld?: CredentialState;
}

export type KeyChoice =
  /** Leave apiKey as written. */
  | { mode: "keep" }
  /** Refer to a secret; `value` (optional) is stored under that name before saving. */
  | {
      mode: "secret";
      secretName: string;
      value: string;
      storage: "secure" | "env";
    }
  /** Remove apiKey from the entry. */
  | { mode: "remove" };

export interface ModelForm {
  fields: Record<string, string | string[] | null>;
  tools: TriState;
  images: TriState;
  headers: HeaderRow[];
  key: KeyChoice;
  /** `capabilities` as written, so names the dialog does not manage are kept. */
  rawCapabilities?: unknown;
}

export function isBooleanField(f: ModelEditField) {
  return f.kind === "boolean";
}

/** The fields of a section that apply to this provider (or are already written). */
export function visibleFields(
  section: ModelEditField["section"],
  provider: string,
  entry: Record<string, unknown> | undefined,
): ModelEditField[] {
  return MODEL_EDIT_FIELDS.filter(
    (f) =>
      f.section === section &&
      f.kind !== "secretRef" &&
      (!f.providers ||
        f.providers.includes(provider) ||
        getPath(entry, f.path) !== undefined),
  );
}

function toInput(f: ModelEditField, raw: unknown): string | string[] | null {
  if (pathKey(f.path) === "roles") {
    return Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : null;
  }
  if (raw === undefined || raw === null) {
    return f.kind === "boolean" ? "default" : "";
  }
  switch (f.kind) {
    case "boolean":
      return raw === true ? "on" : raw === false ? "off" : "default";
    case "list":
      return Array.isArray(raw) ? raw.map(String).join("\n") : String(raw);
    default:
      return String(raw);
  }
}

/** The form for an entry: every field prefilled from what is written. */
export function formFromBlock(info: ModelBlockInfo): ModelForm {
  const entry = info.entry ?? {};
  const fields: ModelForm["fields"] = {};
  for (const f of MODEL_EDIT_FIELDS) {
    if (f.kind === "secretRef") continue;
    fields[pathKey(f.path)] = toInput(f, getPath(entry, f.path));
  }
  const rawHeaders = getPath(entry, ["requestOptions", "headers"]);
  const headers: HeaderRow[] =
    rawHeaders && typeof rawHeaders === "object"
      ? Object.entries(rawHeaders as Record<string, unknown>).map(
          ([name, value], i) => {
            const withheld = info.credentials?.headers[name];
            return withheld
              ? { id: `h${i}`, name, value: "", withheld }
              : { id: `h${i}`, name, value: String(value) };
          },
        )
      : [];
  return {
    fields,
    tools: capabilityState(entry.capabilities, "tool_use"),
    images: capabilityState(entry.capabilities, "image_input"),
    headers,
    key: { mode: "keep" },
    rawCapabilities: entry.capabilities,
  };
}

/** The value to write for a field's input, or undefined to remove the key. */
export function fromInput(
  f: ModelEditField,
  input: string | string[] | null,
): unknown {
  if (pathKey(f.path) === "roles") return input === null ? undefined : input;
  if (typeof input !== "string") return undefined;
  switch (f.kind) {
    case "boolean":
      return input === "on" ? true : input === "off" ? false : undefined;
    case "number":
      return input.trim() === "" ? undefined : Number(input.trim());
    case "list": {
      const items = input
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) return undefined;
      // A single CA bundle is written as a path, as the docs show it
      if (
        pathKey(f.path) === "requestOptions.caBundlePath" &&
        items.length === 1
      ) {
        return items[0];
      }
      return items;
    }
    default:
      return input.trim() === "" ? undefined : input.trim();
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export interface FormResult {
  ops: ModelPatchOp[];
  /** Field-level messages, keyed by path ("apiKey", "requestOptions.headers.X"). */
  errors: Record<string, string>;
}

/**
 * The changes to write: only fields whose input differs from the prefilled
 * one, so a default shown as a placeholder is never written.
 */
export function formToOps(initial: ModelForm, current: ModelForm): FormResult {
  const ops: ModelPatchOp[] = [];
  const errors: Record<string, string> = {};
  const push = (path: string[], value: unknown) => {
    const message = validateFieldValue(path, value);
    if (message) errors[pathKey(path)] = message;
    else ops.push(value === undefined ? { path } : { path, value });
  };

  for (const f of MODEL_EDIT_FIELDS) {
    if (f.kind === "secretRef") continue;
    const k = pathKey(f.path);
    if (same(initial.fields[k], current.fields[k])) continue;
    push(f.path, fromInput(f, current.fields[k]));
  }

  if (current.tools !== initial.tools || current.images !== initial.images) {
    const caps = capabilitiesFor(
      initial.rawCapabilities,
      current.tools,
      current.images,
    );
    if (caps.error) errors.capabilities = caps.error;
    else push(["capabilities"], caps.value);
  }

  headerOps(initial.headers, current.headers, push, errors);

  const key = current.key;
  if (key.mode === "remove") push(["apiKey"], undefined);
  if (key.mode === "secret") {
    if (!isValidSecretName(key.secretName)) {
      errors.apiKey =
        "A secret name is letters, digits and _, not starting with a digit.";
    } else {
      push(["apiKey"], secretRef(key.secretName));
    }
  }
  return { ops, errors };
}

function headerOps(
  before: HeaderRow[],
  after: HeaderRow[],
  push: (path: string[], value: unknown) => void,
  errors: Record<string, string>,
) {
  const seen = new Set<string>();
  for (const row of after) {
    const name = row.name.trim();
    if (!name) {
      if (row.value.trim())
        errors[`requestOptions.headers.${row.id}`] = "Enter the header name.";
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors[`requestOptions.headers.${name}`] = "This header is listed twice.";
      continue;
    }
    seen.add(name.toLowerCase());
    const old = before.find((b) => b.name === name);
    const path = ["requestOptions", "headers", name];
    if (old?.withheld && row.value === "") continue; // kept as written
    if (old && !old.withheld && old.value === row.value) continue;
    if (!row.value.trim() && !old) {
      errors[pathKey(path)] = "Enter a value.";
      continue;
    }
    push(path, row.value.trim());
  }
  for (const old of before) {
    if (!after.some((a) => a.name.trim() === old.name)) {
      push(["requestOptions", "headers", old.name], undefined);
    }
  }
}

/** The message for one field as typed, for showing while editing. */
export function fieldError(
  f: ModelEditField,
  input: string | string[] | null,
): string | undefined {
  if (
    pathKey(f.path) === "roles" &&
    Array.isArray(input) &&
    input.length === 0
  ) {
    return "Pick at least one role, or go back to the default roles.";
  }
  return validateFieldValue(f.path, fromInput(f, input));
}

/** Header values that are credentials must be references. */
export function headerIsSensitive(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}
