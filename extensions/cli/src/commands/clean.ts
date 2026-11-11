/**
 * `continuous clean [--older-than 30d] [--yes]` (ROADMAP X15): delete the
 * product's own persisted files older than an age. Dry run unless `--yes`.
 * Prints counts, sizes and paths, never contents. Only sessions, dev_data and
 * logs under the global folder are touched.
 */
import {
  DEFAULT_RETENTION_DAYS,
  parseAge,
  planClean,
  runClean,
  type CleanPlan,
} from "core/util/cleanStores.js";
import { getGlobalDirPath } from "core/util/paths.js";
import type { Io } from "core/util/secretScan/secretsCli.js";

export interface CleanCommandOptions {
  olderThan?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Global folder; default the real one (tests pass a temp dir). */
  root?: string;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

export const CLEAN_NOTE =
  "Deleting is not secure erasure: SSDs, journals, snapshots and backups can keep the bytes. Rotate any credential that was in a file you removed.";

function summarize(plan: CleanPlan): string[] {
  return (["sessions", "dev_data", "logs"] as const).map((store) => {
    const es = plan.entries.filter((e) => e.store === store);
    const bytes = es.reduce((n, e) => n + e.bytes, 0);
    const dropped = es
      .filter((e) => e.action === "lines")
      .reduce((n, e) => n + (e.lines ?? 0), 0);
    return `${store}: ${es.length} file(s), ${bytes} bytes${dropped ? `, ${dropped} old line(s) inside kept files` : ""}`;
  });
}

export function cleanCommand(
  options: CleanCommandOptions,
  io: Io = consoleIo,
): number {
  const ms = options.olderThan ? parseAge(options.olderThan) : undefined;
  if (options.olderThan && !ms) {
    io.err(`Bad --older-than "${options.olderThan}": use 30d, 12h or 2w.`);
    return 2;
  }
  const root = options.root ?? getGlobalDirPath();
  const plan = planClean(root, ms);
  const apply = !!options.yes && !options.dryRun;
  if (options.json) {
    io.out(
      JSON.stringify({
        root,
        cutoff: plan.cutoff.toISOString(),
        applied: apply,
        entries: plan.entries,
        bytes: plan.bytes,
        result: apply ? runClean(plan) : undefined,
      }),
    );
    return 0;
  }
  io.out(`Global folder: ${root}`);
  io.out(
    ms
      ? `Older than: ${plan.cutoff.toISOString()} (--older-than, all stores)`
      : `Retention defaults used: ${Object.entries(DEFAULT_RETENTION_DAYS)
          .map(([s, d]) => `${s} ${d}d`)
          .join(", ")}. --older-than overrides all of them.`,
  );
  for (const l of summarize(plan)) io.out(l);
  if (!apply) {
    io.out(
      `Dry run: nothing deleted. ${plan.entries.length} file(s), ${plan.bytes} bytes would go. Run with --yes to delete.`,
    );
    io.out(CLEAN_NOTE);
    return 0;
  }
  const r = runClean(plan);
  io.out(
    `Deleted ${r.deletedFiles} file(s), dropped ${r.droppedLines} line(s), ${r.bytes} bytes.${r.failed.length ? ` ${r.failed.length} failed.` : ""}`,
  );
  io.out(CLEAN_NOTE);
  return r.failed.length ? 1 : 0;
}
