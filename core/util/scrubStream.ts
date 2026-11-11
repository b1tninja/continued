import fs from "node:fs";
import { Writable } from "node:stream";

import { PRIVATE_FILE_MODE } from "./privateFiles";
import { scrubForDisk } from "./secretScan/scrubForDisk";

/**
 * A write stream to `file` (owner-only, truncated as createWriteStream was) that scrubs secrets from
 * what passes through (ROADMAP X15). It holds back the unfinished last line
 * until the newline arrives, so a secret is not cut in two by a chunk edge.
 */
export function createScrubbedFileStream(file: string): Writable {
  const out = fs.createWriteStream(file, {
    flags: "w",
    mode: PRIVATE_FILE_MODE,
  });
  let pending = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      pending += chunk.toString();
      const cut = pending.lastIndexOf("\n");
      if (cut === -1) return cb();
      const whole = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      out.write(scrubForDisk(whole), (e) => cb(e));
    },
    final(cb) {
      if (pending) out.write(scrubForDisk(pending));
      out.end(() => cb());
    },
  });
  return sink;
}
