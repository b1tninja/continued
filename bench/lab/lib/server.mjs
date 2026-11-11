// Start and stop llama-server for one GGUF, safely. Rules, all enforced here:
//   - one server at a time (a pid file in the log folder, and a /health probe
//     on the port), loopback only, never `--host` from the caller;
//   - refuse while Ollama has a model loaded (/api/ps) and when nvidia-smi
//     shows less free VRAM than the file plus headroom (or cannot be read);
//   - the log goes under the log folder, which must be an allowed write root;
//   - wait for GET /health to answer 200 (503 while loading), give up on a
//     timeout or when the child exits, and kill the process tree on failure;
//   - the process tree is killed on exit, Ctrl-C and SIGTERM.
// Flag spellings come from the llama.cpp tools/server README: -m, --host,
// --port, --jinja, -ngl, -c, -np, -a, --no-webui, --chat-template,
// --chat-template-file, --cache-reuse, --reasoning-format.
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GB, readNvidiaSmi, sleep } from "./guards.mjs";
import { assertWritable, slug } from "./paths.mjs";

export const DEFAULT_EXE = "M:\\ai\\llama.cpp\\b12206\\llama-server.exe";
export const DEFAULT_PORT = 8080;
export const VRAM_HEADROOM_GB = 2; // beyond the file: KV cache, compute buffers

export class ServerError extends Error {}

const FORBIDDEN_EXTRA = new Set([
  "--host",
  "--port",
  "-m",
  "--model",
  "--no-jinja",
]);

/** The argument vector. Nothing here is taken on trust from `extra`. */
export function buildArgs({
  gguf,
  port = DEFAULT_PORT,
  ctx = 16384,
  ngl = 99,
  parallel = 1,
  alias,
  chatTemplate,
  chatTemplateFile,
  cacheReuse,
  reasoningFormat,
  metrics,
  slots,
  extra = [],
}) {
  if (!gguf) throw new ServerError("a GGUF path is required");
  for (const e of extra)
    if (FORBIDDEN_EXTRA.has(e.split("=")[0]))
      throw new ServerError(
        `${e} is set by the helper and cannot be passed through`,
      );
  const a = [
    "-m",
    gguf,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--jinja",
    "-ngl",
    String(ngl),
    "-c",
    String(ctx),
    "-np",
    String(parallel),
    "-a",
    alias ?? slug(path.basename(gguf).replace(/\.gguf$/i, "")),
    "--no-webui",
  ];
  if (chatTemplate) a.push("--chat-template", chatTemplate);
  if (chatTemplateFile) a.push("--chat-template-file", chatTemplateFile);
  if (cacheReuse != null) a.push("--cache-reuse", String(cacheReuse));
  if (reasoningFormat) a.push("--reasoning-format", reasoningFormat);
  // b12206 --help: --metrics is off by default, --slots on by default
  if (metrics) a.push("--metrics");
  if (slots) a.push("--slots");
  return [...a, ...extra];
}

/** The last `Chat format:` line in a llama-server log, or undefined. */
export function readChatFormat(logFile, read = fs.readFileSync) {
  try {
    const m = [...read(logFile, "utf8").matchAll(/Chat format:\s*(.+)/g)];
    return m.length ? m[m.length - 1][1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Kill a process and its children. Windows: taskkill /T /F; elsewhere SIGKILL. */
export function killTree(
  pid,
  {
    platform = process.platform,
    exec = execFileSync,
    kill = process.kill,
  } = {},
) {
  if (!pid) return false;
  try {
    if (platform === "win32")
      exec("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else kill(pid, "SIGKILL");
    return true;
  } catch {
    return false; // already gone
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function health(fetchImpl, base) {
  try {
    const r = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.status;
  } catch {
    return undefined;
  }
}

/** Refusals that need no process: returns a list of reasons. */
export async function preflight({
  gguf,
  port,
  logDir,
  exe,
  ollamaUrl = "http://127.0.0.1:11434",
  fetchImpl = globalThis.fetch,
  readGpu = readNvidiaSmi,
  exists = fs.existsSync,
  fileSize = (f) => fs.statSync(f).size,
  checkVram = true,
  isAlive = alive,
}) {
  const why = [];
  if (!exists(exe)) why.push(`llama-server not found at ${exe}`);
  if (!exists(gguf)) why.push(`GGUF not found: ${gguf}`);
  const pidFile = path.join(logDir, "llama-server.pid");
  if (exists(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid && isAlive(pid))
      why.push(
        `a llama-server started by the lab is still running (pid ${pid}); run \`server stop\` first`,
      );
  }
  if ((await health(fetchImpl, `http://127.0.0.1:${port}`)) !== undefined)
    why.push(`something already answers on 127.0.0.1:${port}`);
  try {
    const r = await fetchImpl(`${ollamaUrl}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    const loaded = r.ok
      ? ((await r.json()).models ?? []).map((m) => m.name)
      : [];
    if (loaded.length)
      why.push(
        `Ollama has a model loaded (${loaded.join(", ")}): \`ollama stop\` it first; 32 GB VRAM cannot hold both`,
      );
  } catch {
    /* no Ollama answering: nothing of Ollama's is loaded */
  }
  if (checkVram && exists(gguf)) {
    const gpus = readGpu();
    const need = fileSize(gguf) / GB + VRAM_HEADROOM_GB;
    if (!gpus?.length)
      why.push(
        "nvidia-smi is unavailable: cannot verify free VRAM (pass --no-vram-check to override)",
      );
    else if (gpus[0].freeGB < need)
      why.push(
        `needs about ${need.toFixed(1)} GB of VRAM (file + ${VRAM_HEADROOM_GB} GB), ${gpus[0].freeGB.toFixed(1)} GB free`,
      );
  }
  return why;
}

/**
 * Start the server. Returns { baseUrl, pid, logFile, stop(), chatFormat() }.
 * `deps` lets tests inject spawn, fetch, kill and the sleep.
 */
export async function startServer(opts, roots, deps = {}) {
  const {
    spawn = nodeSpawn,
    fetchImpl = globalThis.fetch,
    kill = killTree,
    wait = sleep,
    now = Date.now,
    signal,
  } = deps;
  const exe = opts.exe ?? DEFAULT_EXE;
  const port = opts.port ?? DEFAULT_PORT;
  const logDir = roots.logs;
  const why = await preflight({
    ...opts,
    exe,
    port,
    logDir,
    fetchImpl,
    ...deps.preflight,
  });
  if (why.length)
    throw new ServerError("refusing to start llama-server: " + why.join("; "));
  const args = buildArgs({ ...opts, port });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = assertWritable(
    path.join(logDir, `llama-server-${port}-${stamp}.log`),
    roots,
  );
  const pidFile = assertWritable(path.join(logDir, "llama-server.pid"), roots);
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(logFile, "a");
  fs.writeSync(fd, `# ${exe} ${args.join(" ")}\n`);
  const child = spawn(exe, args, {
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  let exited = child.exitCode != null ? child.exitCode : undefined;
  child.on?.("exit", (code) => {
    exited = code ?? -1;
  });
  fs.writeFileSync(pidFile, String(child.pid));
  let stopped = false;
  const cleanups = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    kill(child.pid);
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      /* best effort */
    }
    for (const c of cleanups) c();
  };
  // Synchronous work only in an exit handler. Ctrl-C is the caller's to
  // handle (the lab finishes its request, then calls stop()); a second Ctrl-C
  // ends the process and the exit handler kills the server.
  const onExit = () => stop();
  const onTerm = () => {
    stop();
    process.exit(143);
  };
  const SIGS = ["SIGTERM", "SIGHUP", "SIGBREAK"];
  if (deps.install !== false) {
    process.on("exit", onExit);
    for (const sg of SIGS) process.on(sg, onTerm);
    cleanups.push(() => {
      process.off("exit", onExit);
      for (const sg of SIGS) process.off(sg, onTerm);
    });
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = now() + (opts.readyTimeoutMs ?? 300_000);
  try {
    for (;;) {
      if (signal?.aborted)
        throw new ServerError("interrupted while waiting for /health");
      if (exited !== undefined)
        throw new ServerError(
          `llama-server exited with code ${exited} before it was ready; see ${logFile}`,
        );
      if ((await health(fetchImpl, base)) === 200) break; // 503 = still loading
      if (now() > deadline)
        throw new ServerError(
          `no /health 200 within the timeout; see ${logFile}`,
        );
      await wait(opts.pollMs ?? 1000, signal);
    }
  } catch (e) {
    stop();
    throw e;
  }
  return {
    baseUrl: base,
    pid: child.pid,
    logFile,
    args,
    stop,
    /** The `Chat format:` line llama.cpp prints when it picks a tool-call handler. */
    chatFormat() {
      return readChatFormat(logFile);
    },
  };
}

/** Stop whatever the pid file names (a server left by a crashed lab process). */
export function stopFromPidFile(roots, { kill = killTree } = {}) {
  const pidFile = path.join(roots.logs, "llama-server.pid");
  if (!fs.existsSync(pidFile)) return { stopped: false, reason: "no pid file" };
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const ok = pid ? kill(pid) : false;
  fs.rmSync(assertWritable(pidFile, roots), { force: true });
  return { stopped: ok, pid };
}
