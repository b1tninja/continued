import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { cacheTips } from "./cacheTips";

function model(
  provider: string,
  id: string,
  extra: Partial<ModelDescription> = {},
): ModelDescription {
  return {
    title: id,
    provider,
    model: id,
    underlyingProviderName: provider,
    ...extra,
  };
}

const ids = (tips: ReturnType<typeof cacheTips>) => tips.map((t) => t.id);

describe("cacheTips: Amazon Nova on Bedrock", () => {
  const novaLite2 = model("bedrock", "us.amazon.nova-2-lite-v1:0");

  it("never says 1 hour is unavailable: Nova has one lifetime and no 1-hour entry", () => {
    for (const setting of ["auto", "1h", "5m", "off", undefined] as const) {
      expect(ids(cacheTips(novaLite2, setting))).not.toContain(
        "one-hour-unavailable",
      );
    }
    // Not even when config asks for a lifetime it cannot take.
    const cfg = model("bedrock", novaLite2.model, {
      completionOptions: { promptCaching: true },
      cacheBehavior: { ttl: "1h" },
    } as any);
    expect(ids(cacheTips(cfg, undefined))).not.toContain(
      "one-hour-unavailable",
    );
  });

  it("warns about the regional premium on Nova 2 Lite, naming AWS", () => {
    const tip = cacheTips(novaLite2, "5m").find(
      (t) => t.id === "regional-premium",
    )!;
    expect(tip.title).toBe("Regional endpoints cost 10% more");
    expect(tip.body).toContain("which AWS prices 10% above a global one");
    expect(tip.body).not.toContain("Anthropic");
    expect(tip.suggestion).toBe("global.amazon.nova-2-lite-v1:0");
  });

  it("has no premium to warn about on the global ID or the other Nova models", () => {
    expect(
      ids(cacheTips(model("bedrock", "global.amazon.nova-2-lite-v1:0"), "5m")),
    ).toEqual([]);
    expect(
      ids(cacheTips(model("bedrock", "us.amazon.nova-pro-v1:0"), "5m")),
    ).toEqual([]);
    expect(
      ids(cacheTips(model("bedrock", "us.amazon.nova-micro-v1:0"), "5m")),
    ).toEqual([]);
  });

  it("still gives the throttling tip with caching off", () => {
    const failures = [
      { at: 1, kind: "throttled" as const },
      { at: 2, kind: "throttled" as const },
    ];
    const tips = cacheTips(novaLite2, "off", undefined, failures as any);
    expect(ids(tips)).toContain("throttled-caching-off");
    expect(tips.find((t) => t.id === "throttled-caching-off")!.body).toContain(
      "Bedrock",
    );
  });
});
