import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordLive } from "./retirementNoticeState.js";
import {
  currentNotice,
  dismissCurrentNotice,
  startupRetirementLine,
} from "./retirementStartup.js";

const file = () => join(mkdtempSync(join(tmpdir(), "startup-")), "n.json");
const sonnet = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
};

describe("startupRetirementLine", () => {
  it("shows once a day, then again the next day", () => {
    const f = file();
    const a = startupRetirementLine({ ...sonnet, now: "2026-11-11", file: f });
    expect(a).toContain("retires on 2026-11-30");
    expect(a).toContain("claude-sonnet-5-5");
    expect(a).toContain("continuous dismiss-notice");
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-11", file: f }),
    ).toBeUndefined();
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-12", file: f }),
    ).toContain("retires on 2026-11-30");
  });

  it("stays hidden after a dismissal, and comes back when the notice changes", () => {
    const f = file();
    expect(
      dismissCurrentNotice({ ...sonnet, now: "2026-11-11", file: f }),
    ).toBe(true);
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-12", file: f }),
    ).toBeUndefined();
    // The model retired: a different severity is a different notice.
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-12-02", file: f }),
    ).toContain("was retired");
  });

  it("says nothing for a current model or another provider", () => {
    const f = file();
    expect(
      startupRetirementLine({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        now: "2026-11-11",
        file: f,
      }),
    ).toBeUndefined();
    expect(
      startupRetirementLine({
        provider: "bedrock",
        model: "claude-sonnet-4-5-20250929",
        now: "2026-11-11",
        file: f,
      }),
    ).toBeUndefined();
    expect(
      dismissCurrentNotice({ provider: "openai", model: "gpt-5", file: f }),
    ).toBe(false);
  });

  it("uses the lifecycle the user's key last returned", () => {
    const f = file();
    recordLive(
      sonnet.model,
      { lifecycle: "deprecated", retiresAt: "2026-12-15T00:00:00Z" },
      "2026-11-10",
      f,
    );
    expect(
      currentNotice({ ...sonnet, now: "2026-11-11", file: f }),
    ).toMatchObject({ from: "live", retiresAt: "2026-12-15" });
  });

  it("never throws on an unwritable state file", () => {
    // A path below a regular file cannot be created on any platform (a
    // drive-letter path is only unwritable on Windows).
    const blocker = join(mkdtempSync(join(tmpdir(), "startup-")), "plain");
    writeFileSync(blocker, "");
    expect(
      startupRetirementLine({
        ...sonnet,
        now: "2026-11-11",
        file: join(blocker, "dir", "n.json"),
      }),
    ).toContain("retires");
  });
});
