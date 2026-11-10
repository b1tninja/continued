/**
 * The escape probes of a jail, as data (plans/jail-network.md, W7a). Each probe
 * is a short bash script that tries one thing a contained command must not be
 * able to do and reports whether it could. `escapeProbeRunner.ts` runs them
 * through a `CommandExecutor`; nothing here starts a process.
 *
 * What a probe result means, and what it does not. These are behavioural
 * probes, not kernel exploits. "pass" says this attempt did not get through,
 * on this machine, with this backend and these versions. It is not a proof
 * that nothing gets through. The claim the UI makes (a later row) is generated
 * from these results and says so.
 *
 * The script contract:
 * - The script runs from the workspace folder, as the command would.
 * - It may print evidence lines. It must never print a secret's value.
 * - It ends by calling `probe_pass` (the attempt failed: contained),
 *   `probe_fail` (it got through) or `probe_skip` (cannot be tried here).
 *   Those print the final `PROBE:<verdict>` line the runner reads.
 * - `{{name}}` is replaced by the shell-quoted value of a canary, so a script
 *   never contains an unquoted value.
 * - It cleans up what it creates, and never writes anything but empty files
 *   with a `probe` name.
 *
 * Not yet here (needs more than a script): the proxy and DNS probes (W7f),
 * the model-key probes (W7g), resource limits (a fork bomb, memory), the host
 * diff after a run, and the backend-specific rows (runtime version against
 * known runc fixes, WSL interop, Seatbelt services).
 */
export type ProbeProperty =
  | "write-scope"
  | "host-executed-files"
  | "read-scope"
  | "environment"
  | "processes"
  | "privilege"
  | "network";

export type ProbeVerdict = "pass" | "fail" | "skip" | "error";

export interface Probe {
  id: string;
  property: ProbeProperty;
  description: string;
  script: string;
  /**
   * A pass proves little, because the attempt could fail for a reason that has
   * nothing to do with the jail (an offline machine, a symlink target that is
   * unwritable anyway). A weak pass never makes a property "verified" alone.
   */
  weak?: boolean;
  /**
   * The probe connects to the harness's canary listener. The runner cross-checks
   * the listener's own count, so a connection the script missed still fails.
   */
  usesListener?: boolean;
}

/** Defined for every script, and prepended by the runner. */
export const PROBE_PRELUDE = `probe_pass() { echo "PROBE:pass"; exit 0; }
probe_fail() { echo "PROBE:fail"; exit 0; }
probe_skip() { echo "PROBE:skip"; exit 0; }
probe_connect() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
  else
    bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
  fi
}
`;

/** Names a script may use, with the canary each stands for. */
export const PROBE_VARIABLES = [
  "canary.dir",
  "canary.ssh",
  "canary.aws",
  "canary.parentEnv",
  "canary.continuousEnv",
  "canary.key",
  "canary.envValue",
  "canary.port",
  "canary.lanHost",
] as const;
export type ProbeVariable = (typeof PROBE_VARIABLES)[number];

const WRITE_PROBE = (target: string) => `f=${target}
if ( : > "$f" ) 2>/dev/null; then echo "created $f"; rm -f "$f"; probe_fail; fi
probe_pass`;

export const COMMON_PROBES: readonly Probe[] = [
  // ------------------------------------------------------------ write scope
  {
    id: "write.host-canary-dir",
    property: "write-scope",
    description: "Create a file in a folder that exists only on the host",
    script: WRITE_PROBE(`{{canary.dir}}/probe-write-$$`),
  },
  {
    id: "write.etc",
    property: "write-scope",
    description: "Create a file in /etc",
    script: WRITE_PROBE(`/etc/.probe-write-$$`),
  },
  {
    id: "write.usr-local",
    property: "write-scope",
    description: "Create a file in /usr/local",
    script: WRITE_PROBE(`/usr/local/.probe-write-$$`),
  },
  {
    id: "write.parent-of-workspace",
    property: "write-scope",
    description: "Create a file in the folder above the workspace",
    script: WRITE_PROBE(`"$PWD/../.probe-parent-$$"`),
  },
  {
    id: "write.symlink-out",
    property: "write-scope",
    description:
      "Make a symlink in the workspace to a folder outside it and write through it",
    weak: true,
    script: `for t in {{canary.dir}} /etc /usr/local; do
  l=./.probe-link-$$
  if ln -s "$t" "$l" 2>/dev/null; then
    if ( : > "$l/probe-symlink-$$" ) 2>/dev/null; then
      echo "wrote through a symlink to $t"; rm -f "$l/probe-symlink-$$" "$l"; probe_fail
    fi
    rm -f "$l"
  fi
done
probe_pass`,
  },
  {
    id: "write.hardlink-out",
    property: "write-scope",
    description: "Hard-link a host file into the workspace",
    script: `l=./.probe-hard-$$
if ln {{canary.ssh}} "$l" 2>/dev/null; then echo "linked a host file"; rm -f "$l"; probe_fail; fi
probe_pass`,
  },

  // ------------------------------------------------- files the host executes
  {
    id: "host-files.writable",
    property: "host-executed-files",
    description:
      "Write the files a host program later reads or runs: git hooks and config, editor tasks, Continuous config, MCP config, direnv, husky. Reported per path.",
    script: `try_write() {
  p=$1; existed=0; [ -e "$p" ] && existed=1
  d=$(dirname "$p"); made=0
  if [ ! -d "$d" ]; then mkdir -p "$d" 2>/dev/null && made=1; fi
  if [ $existed = 1 ]; then ( : >> "$p" ) 2>/dev/null; return $?; fi
  if ( : > "$p" ) 2>/dev/null; then rm -f "$p"; [ $made = 1 ] && rmdir "$d" 2>/dev/null; return 0; fi
  [ $made = 1 ] && rmdir "$d" 2>/dev/null
  return 1
}
bad=""
if [ -d .git ]; then
  for p in .git/hooks/probe-$$ .git/config; do try_write "$p" && bad="$bad $p"; done
fi
for p in .vscode/tasks.json .continuous/probe-$$ .mcp.json .envrc .husky/probe-$$; do
  try_write "$p" && bad="$bad $p"
done
if [ -n "$bad" ]; then echo "writable:$bad"; probe_fail; fi
probe_pass`,
  },

  // ------------------------------------------------------------- read scope
  {
    id: "read.canary-files",
    property: "read-scope",
    description:
      "Read fake credential files that exist on the host: an SSH key, an AWS credentials file, a .env above the workspace, a Continuous .env",
    script: `bad=""
for f in {{canary.ssh}} {{canary.aws}} {{canary.parentEnv}} {{canary.continuousEnv}}; do
  if grep -qF {{canary.key}} "$f" 2>/dev/null; then bad="$bad $f"; fi
done
if [ -n "$bad" ]; then echo "readable:$bad"; probe_fail; fi
probe_pass`,
  },
  {
    id: "read.scan-for-key",
    property: "read-scope",
    description:
      "Search the whole file system for the canary key (a stand-in for the model API key, which must not be inside)",
    script: `command -v timeout >/dev/null 2>&1 || probe_skip
hit=$(timeout 60 grep -rIlF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -m1 {{canary.key}} / 2>/dev/null | head -n 3)
if [ -n "$hit" ]; then echo "found in: $hit"; probe_fail; fi
probe_pass`,
  },

  // ------------------------------------------------------------ environment
  {
    id: "env.host-secret",
    property: "environment",
    description:
      "Look for a secret the harness put in the host's environment, in this environment and in other processes'",
    script: `if env | grep -qF {{canary.envValue}}; then echo "in the environment"; probe_fail; fi
for f in /proc/[0-9]*/environ; do
  if [ -r "$f" ] && cat "$f" 2>/dev/null | tr '\\0' '\\n' | grep -qF {{canary.envValue}}; then echo "in $f"; probe_fail; fi
done
probe_pass`,
  },
  {
    id: "env.ambient-credentials",
    property: "environment",
    description:
      "Credential variables and agent sockets a host shell usually has (names only are reported)",
    script: `bad=""
for v in SSH_AUTH_SOCK DOCKER_HOST AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_BEARER_TOKEN_BEDROCK ANTHROPIC_API_KEY OPENAI_API_KEY GITHUB_TOKEN GH_TOKEN NPM_TOKEN; do
  eval "val=\\"\\\${$v-}\\""
  if [ -n "$val" ]; then bad="$bad $v"; fi
done
if [ -n "$bad" ]; then echo "set:$bad"; probe_fail; fi
probe_pass`,
  },

  // ---------------------------------------------------- processes and sockets
  {
    id: "processes.container-sockets",
    property: "processes",
    description: "Find a Docker, containerd or Podman socket",
    script: `bad=""
for s in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /var/run/podman/podman.sock /run/podman/podman.sock /run/user/*/podman/podman.sock; do
  [ -S "$s" ] && bad="$bad $s"
done
if [ -n "$bad" ]; then echo "found:$bad"; probe_fail; fi
probe_pass`,
  },
  {
    id: "processes.host-visible",
    property: "processes",
    description:
      "Count the processes visible (a host's process table is large)",
    weak: true,
    script: `[ -d /proc/1 ] || probe_skip
n=$(ls /proc 2>/dev/null | grep -c '^[0-9][0-9]*$')
echo "visible processes: $n"
if [ "$n" -gt 50 ]; then probe_fail; fi
probe_pass`,
  },
  {
    id: "processes.kernel-interfaces",
    property: "processes",
    description:
      "Whether the kernel's control files are writable (tested with test -w; nothing is written)",
    script: `bad=""
for f in /proc/sysrq-trigger /proc/sys/kernel/core_pattern /proc/sys/kernel/modprobe; do
  [ -w "$f" ] && bad="$bad $f"
done
for r in $(find /sys/fs/cgroup -maxdepth 3 -name release_agent 2>/dev/null | head -n 5); do
  [ -w "$r" ] && bad="$bad $r"
done
if [ -n "$bad" ]; then echo "writable:$bad"; probe_fail; fi
probe_pass`,
  },

  // -------------------------------------------------------------- privilege
  {
    id: "privilege.capabilities",
    property: "privilege",
    description: "Effective Linux capabilities are empty",
    script: `[ -r /proc/self/status ] || probe_skip
cap=$(awk '/^CapEff:/{print $2}' /proc/self/status)
echo "CapEff: $cap"
case "$cap" in *[!0]*) probe_fail ;; esac
probe_pass`,
  },
  {
    id: "privilege.no-new-privs",
    property: "privilege",
    description:
      "no_new_privs is set, so a setuid program cannot gain privilege",
    script: `[ -r /proc/self/status ] || probe_skip
v=$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)
echo "NoNewPrivs: $v"
[ "$v" = "1" ] || probe_fail
probe_pass`,
  },
  {
    id: "privilege.seccomp",
    property: "privilege",
    description: "A seccomp syscall filter is active",
    script: `[ -r /proc/self/status ] || probe_skip
v=$(awk '/^Seccomp:/{print $2}' /proc/self/status)
echo "Seccomp: $v"
[ "$v" = "2" ] || probe_fail
probe_pass`,
  },
  {
    id: "privilege.user-namespace",
    property: "privilege",
    description: "An unprivileged user namespace cannot be created",
    script: `command -v unshare >/dev/null 2>&1 || probe_skip
if unshare -U true 2>/dev/null; then echo "created a user namespace"; probe_fail; fi
probe_pass`,
  },

  // ---------------------------------------------------------------- network
  {
    id: "network.host-loopback",
    property: "network",
    description: "Connect to a listener on the host's loopback address",
    usesListener: true,
    script: `if probe_connect 127.0.0.1 {{canary.port}}; then echo "reached 127.0.0.1"; probe_fail; fi
probe_pass`,
  },
  {
    id: "network.host-lan-address",
    property: "network",
    description: "Connect to a listener on the host's LAN address",
    usesListener: true,
    script: `if probe_connect {{canary.lanHost}} {{canary.port}}; then echo "reached the LAN address"; probe_fail; fi
probe_pass`,
  },
  {
    id: "network.container-gateway",
    property: "network",
    description:
      "Connect to the host through the names and the default gateway a container runtime provides",
    usesListener: true,
    script: `bad=""
for h in host.docker.internal host.containers.internal gateway.docker.internal; do
  probe_connect $h {{canary.port}} && bad="$bad $h"
done
gw=$(awk 'NR>1 && $2=="00000000"{print $3; exit}' /proc/net/route 2>/dev/null)
if [ -n "$gw" ]; then
  ip=$(printf "%d.%d.%d.%d" 0x\${gw:6:2} 0x\${gw:4:2} 0x\${gw:2:2} 0x\${gw:0:2})
  probe_connect $ip {{canary.port}} && bad="$bad $ip"
fi
if [ -n "$bad" ]; then echo "reached:$bad"; probe_fail; fi
probe_pass`,
  },
  {
    id: "network.public-tcp",
    property: "network",
    description:
      "Open a TCP connection to a public address (this contacts 1.1.1.1:443 when the jail allows it)",
    weak: true,
    script: `if probe_connect 1.1.1.1 443; then echo "reached 1.1.1.1:443"; probe_fail; fi
probe_pass`,
  },
  {
    id: "network.metadata",
    property: "network",
    description: "Open a TCP connection to the cloud metadata address",
    weak: true,
    script: `if probe_connect 169.254.169.254 80; then echo "reached the metadata address"; probe_fail; fi
probe_pass`,
  },
  {
    id: "network.dns",
    property: "network",
    description: "Resolve a public name with the system resolver",
    weak: true,
    script: `command -v getent >/dev/null 2>&1 || probe_skip
if getent hosts example.com >/dev/null 2>&1; then echo "resolved example.com"; probe_fail; fi
probe_pass`,
  },
];

// ------------------------------------------------------------------ rendering

/** `'it'\\''s'`: a value as one shell word, whatever it contains. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type RenderedProbe =
  | { command: string }
  | {
      /** The canaries the script needs and the harness did not make */
      missing: ProbeVariable[];
    };

/**
 * The command that runs a probe: the prelude, a no-op line naming the probe
 * (so a process list or a log says what it was), and the script with its
 * variables filled in.
 */
export function renderProbe(
  probe: Probe,
  vars: Partial<Record<ProbeVariable, string>>,
): RenderedProbe {
  const missing: ProbeVariable[] = [];
  const script = probe.script.replace(/\{\{([A-Za-z.]+)\}\}/g, (_m, name) => {
    const value = vars[name as ProbeVariable];
    if (value === undefined) {
      if (!missing.includes(name as ProbeVariable)) {
        missing.push(name as ProbeVariable);
      }
      return "''";
    }
    return shellQuote(value);
  });
  if (missing.length > 0) return { missing };
  return { command: `${PROBE_PRELUDE}: probe ${probe.id}\n${script}\n` };
}

// ------------------------------------------------------------------- results

export interface ProbeResult {
  id: string;
  property: ProbeProperty;
  verdict: ProbeVerdict;
  weak: boolean;
  /** What the script printed, or why the probe could not run; no secrets */
  evidence: string;
}

export type PropertyStatus = "verified" | "violated" | "unverified";

/**
 * One status per property from its probes. `violated`: any probe failed.
 * `verified`: no failure, no error, and at least one strong probe passed.
 * `unverified`: anything else (everything skipped, errored, or only weak passes).
 * A property with no probe is absent.
 */
export function summarizeProbes(
  results: readonly ProbeResult[],
): Partial<Record<ProbeProperty, PropertyStatus>> {
  const out: Partial<Record<ProbeProperty, PropertyStatus>> = {};
  const properties = new Set(results.map((r) => r.property));
  for (const property of properties) {
    const rs = results.filter((r) => r.property === property);
    if (rs.some((r) => r.verdict === "fail")) out[property] = "violated";
    else if (
      rs.every((r) => r.verdict === "pass" || r.verdict === "skip") &&
      rs.some((r) => r.verdict === "pass" && !r.weak)
    ) {
      out[property] = "verified";
    } else out[property] = "unverified";
  }
  return out;
}
