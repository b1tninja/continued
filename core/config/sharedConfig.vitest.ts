import { describe, expect, it } from "vitest";
import { sharedConfigSchema } from "./sharedConfig";

describe("permissionsIntroDismissed", () => {
  it("is a boolean in the shared config schema", () => {
    expect(
      sharedConfigSchema.safeParse({ permissionsIntroDismissed: true }).success,
    ).toBe(true);
    expect(
      sharedConfigSchema.safeParse({ permissionsIntroDismissed: "yes" })
        .success,
    ).toBe(false);
  });
});
