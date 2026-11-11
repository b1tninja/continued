// Before/after comparison without a dependency. The pixel work runs inside the
// browser (a canvas decodes both PNGs), so no PNG decoder is needed in Node:
// `countDiff` is a plain function over two RGBA arrays, tested in Node and
// injected into the page as source text.

/**
 * Compares two RGBA buffers of the same size. A pixel counts as changed when
 * its colour distance (0 to 1, Euclidean over RGB and alpha, normalised) is
 * above `threshold`. Returns the count and, when `mark` is given, paints the
 * changed pixels magenta into it (a copy of `a` dimmed, otherwise).
 */
export function countDiff(a, b, threshold, mark) {
  const max = Math.sqrt(4 * 255 * 255);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    const da = a[i + 3] - b[i + 3];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db + da * da) / max;
    const isChanged = dist > threshold;
    if (isChanged) changed++;
    if (mark) {
      if (isChanged) {
        mark[i] = 255;
        mark[i + 1] = 0;
        mark[i + 2] = 255;
        mark[i + 3] = 255;
      } else {
        mark[i] = a[i] * 0.3 + 178;
        mark[i + 1] = a[i + 1] * 0.3 + 178;
        mark[i + 2] = a[i + 2] * 0.3 + 178;
        mark[i + 3] = 255;
      }
    }
  }
  return changed;
}

/**
 * Runs in the page: decodes two base64 PNGs, compares them, returns the
 * counts and a diff image as base64 PNG. Source text of this function is
 * evaluated in the browser, so it may use only its arguments and DOM APIs;
 * `countDiffSource` is the text of countDiff.
 */
export async function pageCompare(aB64, bB64, threshold, countDiffSource) {
  const countDiff = new Function(`return (${countDiffSource})`)();
  const load = (b64) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not decode a PNG"));
      img.src = "data:image/png;base64," + b64;
    });
  const [a, b] = await Promise.all([load(aB64), load(bB64)]);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sizeMismatch: true,
      before: [a.width, a.height],
      after: [b.width, b.height],
    };
  }
  const pixels = (img) => {
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const da = pixels(a);
  const db = pixels(b);
  const out = new ImageData(a.width, a.height);
  const changed = countDiff(da.data, db.data, threshold, out.data);
  const c = document.createElement("canvas");
  c.width = a.width;
  c.height = a.height;
  c.getContext("2d").putImageData(out, 0, 0);
  return {
    sizeMismatch: false,
    width: a.width,
    height: a.height,
    changed,
    total: a.width * a.height,
    diffPng: c.toDataURL("image/png").split(",")[1],
  };
}

/** Which pictures are new, gone, or in both, from two manifests' entry lists. */
export function pairEntries(before, after) {
  const b = new Map((before ?? []).map((e) => [e.name, e]));
  const a = new Map((after ?? []).map((e) => [e.name, e]));
  return {
    both: [...a.keys()].filter((n) => b.has(n)),
    added: [...a.keys()].filter((n) => !b.has(n)),
    removed: [...b.keys()].filter((n) => !a.has(n)),
  };
}

/**
 * One line per picture and a verdict. `results` is
 * [{ name, changed, total, sizeMismatch }]; a picture has changed when its
 * size differs or its share of changed pixels is above `tolerance`.
 */
export function summarize(results, pairs, tolerance) {
  const rows = results.map((r) => {
    const share = r.sizeMismatch ? 1 : r.changed / r.total;
    const different = r.sizeMismatch || share > tolerance;
    return { ...r, share, different };
  });
  const lines = rows.map((r) =>
    r.sizeMismatch
      ? `${r.name}: size changed ${r.before.join("x")} -> ${r.after.join("x")}`
      : `${r.name}: ${r.changed} of ${r.total} pixels (${(r.share * 100).toFixed(3)}%)${r.different ? " CHANGED" : ""}`,
  );
  for (const n of pairs.added) lines.push(`${n}: new`);
  for (const n of pairs.removed) lines.push(`${n}: missing from this run`);
  const anyChanged =
    rows.some((r) => r.different) ||
    pairs.added.length > 0 ||
    pairs.removed.length > 0;
  return { rows, lines, anyChanged };
}
