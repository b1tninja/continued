// Chooses the browser executable. Playwright's own Chromium is used when its
// cache holds the build this playwright-core version wants; otherwise the
// system Edge or Chrome. Inside Windows Sandbox only Edge works (see README:
// Smart App Control blocks unsigned binaries such as Playwright's Chromium).
import fs from "node:fs";

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const firstExisting = (list, exists) => list.find((p) => exists(p));

/**
 * Returns { kind, executablePath? } for the preference, or throws with what
 * was looked for. `chromium` means "let playwright-core use its cache" and is
 * verified by `playwrightExecutable` (its chromium.executablePath()).
 */
export function chooseBrowser(
  prefer,
  { exists = fs.existsSync, playwrightExecutable } = {},
) {
  const tries = [];
  const order = prefer === "auto" ? ["chromium", "edge", "chrome"] : [prefer];
  for (const kind of order) {
    if (kind === "chromium") {
      const p = playwrightExecutable?.();
      tries.push(`chromium (${p ?? "no playwright executable"})`);
      if (p && exists(p)) return { kind, executablePath: p };
    } else {
      const list = kind === "edge" ? EDGE : CHROME;
      const p = firstExisting(list, exists);
      tries.push(`${kind} (${list.join(" | ")})`);
      if (p) return { kind, executablePath: p };
    }
  }
  throw new Error(
    "No browser found. Looked for: " +
      tries.join("; ") +
      ". Install Playwright's Chromium with `npx playwright-core install chromium-headless-shell` or install Edge or Chrome.",
  );
}
