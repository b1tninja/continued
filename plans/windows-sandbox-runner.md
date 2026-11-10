# Windows Sandbox runner

`extensions/cli/scripts/sandboxRun.ts` runs one command in a fresh Windows
Sandbox and brings its stdout, stderr and exit code back. The pure parts (config
XML, payload copy, VPN preflight, result protocol) are in
`core/util/windowsSandboxRun.ts` with unit tests. Windows 11 Pro, build 26100 or
newer, `wsb.exe` required (see `core/util/windowsSandboxStatus.ts`).

## Usage

```
cd extensions/cli
npx tsx --tsconfig scripts/tsconfig.json scripts/sandboxRun.ts \
  --payload <dir> --cmd "node run.mjs args" \
  [--network on|off] [--timeout 300] [--out <dir>] [--keep] [--ignore-vpn]
```

- `--payload` is copied (no `.git`, no `node_modules`, no file over 10 MB; the
  script prints what was copied and skipped) and mapped read-only at
  `C:\payload`, which is the working directory of the command.
- The host's Node install folder (`dirname(process.execPath)`) is mapped
  read-only at `C:\node` and put first on `PATH`, so `node` works.
- `--out` (default: a temp folder) is mapped writable at `C:\out`. The command
  can write files there; they appear on the host.
- `--cmd` is cmd.exe syntax, written into a batch file (`%` must be `%%`).
- `--network` defaults to `off`. `--timeout` is seconds (default 300); on
  timeout the sandbox is stopped, which kills the command, and the exit code of
  the script is 124. Otherwise the script exits with the command's exit code
  (an NTSTATUS or other value over 255 becomes 1).
- No environment or secret is passed in; do not put keys in the payload.

Result protocol: the wrapper writes `stdout.txt`, `stderr.txt`, `exit.txt` and
last a `DONE` marker into `C:\out`; the runner polls for `DONE`.

The sandbox is always stopped: in a `finally`, and on Ctrl-C. The script prints
`sandboxes left: N` from `wsb list` after stopping. It refuses to start when a
sandbox is already running, and when a VPN adapter is connected and `--network
on` was asked (`--ignore-vpn` skips the check). A VPN client that is running
with no adapter up only warns.

## Facts it is built on

- `wsb start --config "<xml>"` (one line, no inner double quotes) creates a
  sandbox with no logged-on user: `<LogonCommand>` never runs and
  `wsb exec -r ExistingLogin` fails. `wsb exec --id <id> -r System -c "<cmd>"`
  works without a logon and returns only when the command has finished, so the
  runner starts it without waiting and polls the result files.
- Mapped folders are snapshots taken at start, so everything (payload, runner
  batch file, Node, out folder) is prepared before the start. A later addition
  needs `wsb share --id <id> -f <host> -s <C:\name> [-w]`.
- Git for Windows cannot start in the sandbox (0xC0000142), so a payload is
  copied with plain file operations, never `git`.
- A clean sandbox has no Node, hence the Node mapping.
- `wsb exec` returns no process output, hence the out share.
- Only one sandbox runs at a time; a stale one holds its mapped folders open
  (`wsb list`, `wsb stop --id <id>`).
- A connected NordVPN stopped the sandbox's network and logon on this machine
  before. The preflight looks at running VPN client processes and at adapters
  with a VPN-like name that are up.
- A batch-file trap fixed here: `echo %errorlevel%> file` treats `1>` as a
  handle redirect and writes nothing; the redirection goes first.

## Measured (2026-11-10, this machine, Windows 11 Pro build 26300)

NordVPN was running but its adapters (NordLynx, OpenVPN Data Channel Offload)
were Disconnected, so the VPN check warned and did not refuse. No VPN was
disabled.

1. Payload printing node version, OS, user, writing a file, running
   `git --version`: stdout and exit code came back. Node v25.9.0 (the host's),
   `Windows_NT 10.0.26100`, user `SYSTEM`, file written to `C:\out`, git failed
   with `ENOENT` (not on PATH inside; git is not installed there), the script
   exited 3 as designed. `wsb list` was empty afterwards.
2. Network:
   - `--network on`: `fetch https://example.com` returned 200 (577 bytes,
     about 105 ms) and the DNS lookup of `bedrock-runtime.us-east-1.amazonaws.com`
     returned 8 addresses (about 120 ms). Run 3 times with the same result.
   - `--network off`: the fetch and the lookup both failed with `ENOTFOUND`
     (40 ms), exit 1. The network claim is confirmed in both directions; only
     DNS and HTTPS were tried, not a Bedrock request.
3. Timeout: a script that never exits with `--timeout 20`: output
   `sleeping forever`, `TIMEOUT after 20s; killing the sandbox.`, script exit 124,
   `sandboxes left: 0`.
4. Timings (ms, one run each unless noted):

   | phase                                 | ms           |
   | ------------------------------------- | ------------ |
   | prepare (copy payload, write batch)   | 1 to 2       |
   | `wsb start` with three mapped folders | 950 to 2040  |
   | run: `cmd /c echo hi`                 | 337          |
   | run: `node --version`                 | 880 to 890   |
   | run: network script, network on       | 1110 to 1320 |
   | `wsb stop`                            | 390 to 450   |
   | whole cycle, trivial command          | 2200 to 4000 |

   Two network-off runs that ended with `process.exit(1)` / a nonzero exit took
   about 15.6 s in the run phase, against under 1.3 s for the same script with
   the network on and for `node --version` with it off. The cause was not
   determined (a Node exit with network lookups failed and pending is the
   suspect); a script that exits cleanly with `process.exitCode` is not affected
   in the runs above.

## Known limits

- Snapshot mappings: a payload cannot change after the start.
- No git, no installers; anything the payload needs must be in the copied
  folder or in the host Node install.
- Output is read only when the command finishes; there is no live streaming.
  A timed-out run returns whatever the files held at that moment.
- The command runs as System, not as a normal user.
- A Node exit with an outstanding `fetch` timer on Node 25 printed a libuv
  assertion (`UV_HANDLE_CLOSING`) with `process.exit`; use `process.exitCode`.
- `WindowsSandboxServer.exe` can remain as a process after the sandbox is
  stopped; `wsb list` is the measure of whether a sandbox is running.
- Host VPN: only a connected adapter is treated as blocking; whether a
  connected VPN still blocks this no-logon path was not retested.
