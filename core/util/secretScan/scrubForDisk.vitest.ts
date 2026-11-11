import { describe, expect, it } from "vitest";

import { scrubDeep, scrubForDisk } from "./scrubForDisk";

/** Secret-shaped strings are built at run time so no literal sits in the source. */
export function canary() {
  return {
    anthropic: ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-"),
    aws: "AKIA" + "QWERTYUIOPASDFGH".slice(0, 16),
    github: "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5".slice(0, 36),
  };
}

describe("scrubForDisk", () => {
  it("removes provider keys and keeps the rest", () => {
    const c = canary();
    const out = scrubForDisk(`run curl -H "x-api-key: ${c.anthropic}" now`);
    expect(out).not.toContain(c.anthropic);
    expect(out).toContain("[REDACTED:");
    expect(out.startsWith("run curl")).toBe(true);
  });

  it("is idempotent and leaves clean text untouched", () => {
    const c = canary();
    const once = scrubForDisk(`AWS_ACCESS_KEY_ID=${c.aws}`);
    expect(scrubForDisk(once)).toBe(once);
    expect(scrubForDisk("ls -la src")).toBe("ls -la src");
  });

  it("scrubs every string in a JSON value and keeps it valid", () => {
    const c = canary();
    const v = {
      toolCallArgs: JSON.stringify({ command: `echo ${c.github}` }),
      n: 3,
      list: [`token ${c.anthropic}`, { deep: c.anthropic }],
    };
    const text = JSON.stringify(scrubDeep(v));
    expect(text).not.toContain(c.github);
    expect(text).not.toContain(c.anthropic);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(scrubDeep(v).n).toBe(3);
  });
});
