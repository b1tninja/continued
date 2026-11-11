/**
 * `continuous secrets scan <paths...> [--profile at-rest|outbound] [--json]`:
 * the command body, shared by the CLI and `extensions/cli/scripts/secretScan.ts`
 * so a pre-commit hook in another repository runs the same code. Node only.
 *
 * Exit codes: 0 no findings, 2 usage error, 3 findings. Output names the rule,
 * file, line, column and fingerprint; it never prints a value or a line.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import {
  formatHistorySummary,
  HISTORY_MAX_BYTES,
  historyRoots,
  looseFiles,
} from "./historyScan";

import { machineMatcher } from "./machineSecrets";
import {
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_USAGE,
  expandPaths,
  formatReport,
  scanFileList,
} from "./scanFiles";
import type { SecretProfile } from "./types";

export interface SecretsScanOptions {
  profile?: string;
  json?: boolean;
  /** Fingerprint salt. Give the same one on every run to keep fingerprints comparable. */
  salt?: string;
  /** Fingerprints to treat as not secrets (under the same salt). */
  allow?: string[] | string;
  /** Scan the files staged in git instead of `paths`. */
  staged?: boolean;
  /** Match this machine's own secret values too. Default true. */
  known?: boolean;
  /** Home directory for the known-values search; default the real one. */
  home?: string;
  /** Scan this product's own stores (sessions, dev_data, logs). */
  history?: boolean;
  /** With `history`: also read ~/.claude/projects transcripts, read-only. */
  includeClaudeCode?: boolean;
  /** The global folder `history` scans. Set by the caller. */
  globalDir?: string;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

function stagedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { encoding: "utf8" },
  );
  return out.split("\0").filter(Boolean);
}

function parseProfile(value: string | undefined): SecretProfile | undefined {
  if (value === undefined) return "at-rest";
  return value === "at-rest" || value === "outbound" ? value : undefined;
}

/** Run the scan and return the exit code. */
export function runSecretsScan(
  paths: readonly string[],
  options: SecretsScanOptions,
  io: Io = consoleIo,
): number {
  const profile = parseProfile(options.profile);
  if (!profile) {
    io.err(`Unknown profile "${options.profile}": use at-rest or outbound.`);
    return EXIT_USAGE;
  }
  let inputs = [...paths];
  if (options.history) {
    if (!options.globalDir) {
      io.err("--history needs the global folder.");
      return EXIT_USAGE;
    }
    inputs.push(
      ...historyRoots({
        globalDir: options.globalDir,
        includeClaudeCode: options.includeClaudeCode,
        home: options.home ?? os.homedir(),
      }).filter((p) => fs.existsSync(p)),
    );
    if (!inputs.length) {
      io.out("History: no stores found, nothing to scan.");
      return EXIT_CLEAN;
    }
  } else if (options.includeClaudeCode) {
    io.err("--include-claude-code only applies with --history.");
    return EXIT_USAGE;
  }
  if (options.staged) {
    try {
      inputs = [...inputs, ...stagedFiles()];
    } catch {
      io.err("--staged needs git and a repository.");
      return EXIT_USAGE;
    }
  }
  if (!inputs.length) {
    io.err("Nothing to scan: give paths, or --staged.");
    return EXIT_USAGE;
  }
  const { files, missing } = expandPaths(inputs);
  for (const m of missing) io.err(`No such file or directory: ${m}`);
  if (missing.length && !files.length) return EXIT_USAGE;

  const machine =
    options.known === false
      ? undefined
      : machineMatcher({ home: options.home });
  const allow = new Set(
    ([] as string[]).concat(options.allow ?? []).flatMap((s) => s.split(",")),
  );
  const report = scanFileList(files, {
    profile,
    salt: options.salt,
    known: machine?.matcher,
    allowFingerprints: allow,
    maxBytes: options.history ? HISTORY_MAX_BYTES : undefined,
  });
  if (options.json) {
    io.out(
      JSON.stringify(
        {
          ...report,
          knownValues: machine
            ? { count: machine.matcher.size, sources: machine.sources }
            : null,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(formatReport(report));
    if (options.history) {
      for (const l of formatHistorySummary(report, looseFiles(files)))
        io.out(l);
    }
  }
  return report.findings.length ? EXIT_FINDINGS : EXIT_CLEAN;
}
