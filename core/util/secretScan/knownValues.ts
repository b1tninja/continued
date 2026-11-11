/**
 * Exact-value matching of this machine's own secrets: the strongest detector
 * this product can have, because it needs no guess about shape.
 *
 * The matcher holds SHA-256 digests and rolling hashes, never the values. It
 * cannot return, print or serialise a value (the object has no field for one),
 * and a value that was handed in is not referenced after `knownValueMatcher`
 * returns. Matching is a Rabin-Karp pass per distinct value length with a
 * full digest check on each candidate, so it stays linear in the text for the
 * handful of lengths a machine's secrets have.
 *
 * A value is skipped when it is shorter than `MIN_KNOWN_LENGTH`, because a
 * short value matches ordinary text: that trade is documented, not hidden.
 */
import { fingerprintOf } from "./scan";
import { sha256Hex } from "./sha256";
import type { KnownMatch, KnownValueMatcher } from "./types";

export const MIN_KNOWN_LENGTH = 8;

const BASE = 1000003;

interface Bucket {
  rolling: Set<number>;
  digests: Set<string>;
}

function polyHash(s: string, from: number, len: number): number {
  let h = 0;
  for (let i = 0; i < len; i++)
    h = (Math.imul(h, BASE) + s.charCodeAt(from + i)) | 0;
  return h;
}

function highPower(len: number): number {
  let p = 1;
  for (let i = 1; i < len; i++) p = Math.imul(p, BASE);
  return p;
}

function scanBucket(
  text: string,
  len: number,
  bucket: Bucket,
  salt: string,
  out: KnownMatch[],
): void {
  if (text.length < len) return;
  const power = highPower(len);
  let h = polyHash(text, 0, len);
  for (let i = 0; ; i++) {
    if (bucket.rolling.has(h)) {
      const candidate = text.slice(i, i + len);
      if (bucket.digests.has(sha256Hex(candidate))) {
        out.push({
          start: i,
          end: i + len,
          fingerprint: fingerprintOf(candidate, salt),
        });
      }
    }
    if (i + len >= text.length) break;
    h =
      (Math.imul(h - Math.imul(text.charCodeAt(i), power), BASE) +
        text.charCodeAt(i + len)) |
      0;
  }
}

/** Drop overlaps from the per-length passes, keeping the longest. */
function longestFirst(matches: KnownMatch[]): KnownMatch[] {
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: KnownMatch[] = [];
  for (const m of matches) {
    if (!out.length || m.start >= out[out.length - 1].end) out.push(m);
  }
  return out;
}

/**
 * Build a matcher over `values`. Values shorter than `MIN_KNOWN_LENGTH` and
 * non-strings are ignored. The returned object keeps digests only.
 */
export function knownValueMatcher(
  values: Iterable<string>,
  minLength = MIN_KNOWN_LENGTH,
): KnownValueMatcher {
  const buckets = new Map<number, Bucket>();
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < minLength) continue;
    const digest = sha256Hex(value);
    if (seen.has(digest)) continue;
    seen.add(digest);
    let b = buckets.get(value.length);
    if (!b) {
      b = { rolling: new Set(), digests: new Set() };
      buckets.set(value.length, b);
    }
    b.rolling.add(polyHash(value, 0, value.length));
    b.digests.add(digest);
  }
  return {
    size: seen.size,
    find(text: string, salt: string): KnownMatch[] {
      const out: KnownMatch[] = [];
      for (const [len, bucket] of buckets)
        scanBucket(text, len, bucket, salt, out);
      return longestFirst(out);
    },
  };
}
