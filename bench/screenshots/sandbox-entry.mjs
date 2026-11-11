// Runs INSIDE the Windows Sandbox, as the logged-on user, from C:\payload
// (see lib/sandbox.mjs). Reads job.json, takes the pictures with the sandbox's
// own Edge into C:\out\shots, writes C:\out\entry-result.json.
import fs from "node:fs";
import { shoot } from "./lib/shoot.mjs";

const job = JSON.parse(fs.readFileSync("C:/payload/job.json", "utf8"));
try {
  const manifest = await shoot({
    dist: "C:/payload/dist",
    out: "C:/out/shots",
    jobs: job.jobs,
    playwrightDir: "C:/payload/vendor/playwright-core",
    browser: "edge",
  });
  fs.writeFileSync(
    "C:/out/entry-result.json",
    JSON.stringify({ ok: true, entries: manifest.entries.length }),
  );
} catch (e) {
  fs.writeFileSync(
    "C:/out/entry-result.json",
    JSON.stringify({ ok: false, error: String(e?.stack ?? e) }),
  );
  process.exitCode = 1;
}
