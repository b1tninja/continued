import * as YAML from "yaml";

/**
 * Apply `next` onto a parsed YAML document in place, so comments, key order and
 * untouched values survive. Plain `YAML.stringify(next)` drops every comment.
 *
 * Rules:
 * - A key whose value is deep-equal to the old one is left alone.
 * - Maps are merged key by key (keys missing from `next` are removed).
 * - Sequences keep the existing node when equal; otherwise items are updated
 *   by index, so a comment on an unchanged item survives, and the tail is
 *   truncated or extended.
 * - Scalars are replaced in place, keeping the node's comments.
 */
export function applyToDocument(
  doc: YAML.Document.Parsed | YAML.Document,
  next: unknown,
): void {
  if (!YAML.isMap(doc.contents) || !isPlainObject(next)) {
    doc.contents = doc.createNode(next) as any;
    return;
  }
  mergeMap(doc, doc.contents, next);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeMap(
  doc: YAML.Document,
  map: YAML.YAMLMap,
  next: Record<string, unknown>,
): void {
  // Remove keys that are gone.
  for (const item of [...map.items]) {
    const key = YAML.isScalar(item.key)
      ? String(item.key.value)
      : String(item.key);
    if (!(key in next)) map.delete(key);
  }
  // Add or update the rest, in the order of `next` only for new keys.
  for (const [key, value] of Object.entries(next)) {
    const existing = map.get(key, true);
    if (existing === undefined) {
      map.set(key, doc.createNode(value));
      continue;
    }
    if (deepEqual(toJS(existing), value)) continue;
    mergeValue(doc, map, key, existing, value);
  }
}

function toJS(node: unknown): unknown {
  return YAML.isNode(node) ? (node as YAML.Node).toJSON() : node;
}

function mergeValue(
  doc: YAML.Document,
  map: YAML.YAMLMap,
  key: string,
  existing: unknown,
  value: unknown,
): void {
  if (YAML.isMap(existing) && isPlainObject(value)) {
    mergeMap(doc, existing, value);
  } else if (YAML.isSeq(existing) && Array.isArray(value)) {
    mergeSeq(doc, existing, value);
  } else if (
    YAML.isScalar(existing) &&
    !isPlainObject(value) &&
    !Array.isArray(value)
  ) {
    existing.value = value as any;
  } else {
    map.set(key, doc.createNode(value));
  }
}

function mergeSeq(
  doc: YAML.Document,
  seq: YAML.YAMLSeq,
  next: unknown[],
): void {
  next.forEach((value, i) => {
    const existing = seq.items[i];
    if (existing === undefined) {
      seq.add(doc.createNode(value));
    } else if (!deepEqual(toJS(existing), value)) {
      if (YAML.isMap(existing) && isPlainObject(value)) {
        mergeMap(doc, existing, value);
      } else if (
        YAML.isScalar(existing) &&
        !isPlainObject(value) &&
        !Array.isArray(value)
      ) {
        existing.value = value as any;
      } else {
        seq.items[i] = doc.createNode(value);
      }
    }
  });
  while (seq.items.length > next.length) seq.items.pop();
}

export interface YamlEditResult {
  /** Text to write, or undefined when nothing changed (skip the write). */
  text: string | undefined;
  /** Why nothing was written, when `text` is undefined and the input was bad. */
  error?: string;
}

/**
 * Edit YAML text with a callback that takes and returns a plain object,
 * keeping comments and key order. Returns `text: undefined` when the result is
 * unchanged. An unparsable document is reported and left untouched.
 */
export function editYamlText<T>(
  source: string,
  callback: (config: T) => T,
): YamlEditResult {
  const doc = YAML.parseDocument(source);
  if (doc.errors.length > 0) {
    return { text: undefined, error: doc.errors[0].message };
  }
  const current = doc.toJS();
  if (!isPlainObject(current)) {
    return { text: undefined, error: "config.yaml is not a valid object" };
  }
  const updated = callback(structuredClone(current) as T);
  if (deepEqual(current, updated)) return { text: undefined };

  applyToDocument(doc, updated);
  // flowCollectionPadding:false keeps `[chat]` from becoming `[ chat ]`.
  const text = doc.toString({ flowCollectionPadding: false });
  return { text: text === source ? undefined : text };
}
