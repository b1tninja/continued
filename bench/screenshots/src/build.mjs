// Builds the harness with the vite that gui/ already has installed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOTS_DIR = path.resolve(here, "..");
export const REPO = path.resolve(SCREENSHOTS_DIR, "..", "..");

/** The folder of playwright-core: $SCREENSHOT_PLAYWRIGHT or this tool's node_modules. */
export function playwrightDir(env = process.env) {
  const dir =
    env.SCREENSHOT_PLAYWRIGHT ??
    path.join(SCREENSHOTS_DIR, "node_modules", "playwright-core");
  if (!fs.existsSync(path.join(dir, "index.mjs"))) {
    throw new Error(
      `playwright-core not found at ${dir}. Run: cd bench/screenshots && npm install --ignore-scripts ` +
        "(or point SCREENSHOT_PLAYWRIGHT at a playwright-core folder).",
    );
  }
  return dir;
}

/** Builds the harness into a new temp folder and returns it. Throws with vite's output on failure. */
export function buildHarness() {
  const gui = path.join(REPO, "gui");
  let vite;
  try {
    vite = path.join(
      path.dirname(
        createRequire(path.join(gui, "package.json")).resolve(
          "vite/package.json",
        ),
      ),
      "bin",
      "vite.js",
    );
  } catch {
    throw new Error("vite not found: run `npm ci` in gui/ first.");
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-harness-"));
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      vite,
      "build",
      "--config",
      path.join(SCREENSHOTS_DIR, "vite.config.mjs"),
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    { cwd: gui, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(
      "harness build failed:\n" +
        // eslint-disable-next-line no-control-regex
        `${r.stdout}\n${r.stderr}`
          .replace(/\u001b\[[0-9;]*m/g, "")
          .slice(-3000),
    );
  }
  console.error(`built harness in ${Date.now() - t0} ms -> ${outDir}`);
  return outDir;
}
