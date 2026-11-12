import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

describe("package.json bin map", () => {
  it("exposes both `continuous` and the short alias `cn`", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(dir, "..", "package.json"), "utf8"),
    );
    expect(pkg.bin).toEqual({
      continuous: "dist/cn.js",
      cn: "dist/cn.js",
    });
  });
});
