import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The core process may be started with the workspace as its working
// directory (an editor launched from a project folder). A repository .env
// must not be able to set the names that decide where the person's own
// config lives or what a shell command inherits (#425 does the same in the
// CLI).
const NAMES = [
  "CONTINUOUS_GLOBAL_DIR",
  "CONTINUE_GLOBAL_DIR",
  "CONTINUE_TERMINAL_ENV",
  "CONTINUE_AUDIT",
  "CONTINUOUS_TERMINAL_SHELL",
  "NODE_OPTIONS",
  "HTTPS_PROXY",
] as const;

describe("core does not load the working directory's .env", () => {
  let cwd: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-cwd-env-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      NAMES.map((n) => `${n}=from-repo`).join("\n"),
    );
    for (const n of [...NAMES, "CONTINUOUS_IGNORE_CWD_ENV"]) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
    process.chdir(dir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves those names unset after core's path module loads", async () => {
    await import("./paths");
    for (const n of NAMES) expect(process.env[n], n).toBeUndefined();
  });
});
