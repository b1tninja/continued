import {
  effectiveRecoverySetting,
  modelSchema,
  RECOVER_ENV,
  RECOVER_FIELD,
  recoverySettingAsks,
  recoveryValueFor,
  withToolDialect,
} from "./browser.js";

const base = { name: "m", model: "qwen3-coder", provider: "openai" };

describe("toolDialect schema", () => {
  it.each([
    "auto",
    "native",
    "qwen-xml",
    "pythonic",
    "llama-json",
    "hermes-json",
    "glm-xml",
    "kimi-tokens",
    "kimi-xtml",
    "minimax-xml",
    "minimax-ns-xml",
    "off",
  ])("accepts %s", (v) => {
    expect(modelSchema.parse({ ...base, toolDialect: v }).toolDialect).toBe(v);
  });

  it("is optional", () => {
    expect(modelSchema.parse(base).toolDialect).toBeUndefined();
  });

  it("rejects an unknown value with a clear message", () => {
    const r = modelSchema.safeParse({ ...base, toolDialect: "xml" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "toolDialect must be one of: auto, native, qwen-xml, pythonic, llama-json, hermes-json, glm-xml, kimi-tokens, kimi-xtml, minimax-xml, minimax-ns-xml, off",
    );
  });
});

describe("withToolDialect", () => {
  const body = { a: 1 };
  it("changes nothing when absent or auto", () => {
    expect(withToolDialect(body, undefined, {})).toBe(body);
    expect(withToolDialect(body, "auto", {})).toBe(body);
    expect(withToolDialect(undefined, undefined, {})).toBeUndefined();
  });
  it("maps a dialect onto the recovery field", () => {
    expect(withToolDialect(body, "qwen-xml", {})).toEqual({
      a: 1,
      [RECOVER_FIELD]: "force:qwen-xml",
    });
  });
  it("maps native and off to recovery off", () => {
    expect(recoveryValueFor("native")).toBe("");
    expect(withToolDialect(undefined, "off", {})).toEqual({
      [RECOVER_FIELD]: "",
    });
  });
  it("lets the environment variable win when set", () => {
    const env = { [RECOVER_ENV]: "qwen-xml" };
    expect(withToolDialect({ [RECOVER_FIELD]: "x", a: 1 }, "off", env)).toEqual(
      { a: 1 },
    );
    expect(withToolDialect(body, "pythonic", env)).toBe(body);
  });
});

describe("effectiveRecoverySetting", () => {
  it("is undefined when nothing asks for recovery", () => {
    expect(effectiveRecoverySetting(undefined, undefined, {})).toBeUndefined();
    expect(effectiveRecoverySetting("auto", { a: 1 }, {})).toBeUndefined();
  });
  it("reads the model's toolDialect, then the extra body field", () => {
    expect(effectiveRecoverySetting("llama-json", undefined, {})).toBe(
      "force:llama-json",
    );
    expect(effectiveRecoverySetting("off", undefined, {})).toBe("");
    expect(
      effectiveRecoverySetting(undefined, { [RECOVER_FIELD]: "qwen-xml" }, {}),
    ).toBe("qwen-xml");
  });
  it("lets the environment variable win, and ignores an empty one", () => {
    expect(
      effectiveRecoverySetting("off", undefined, { [RECOVER_ENV]: "pythonic" }),
    ).toBe("pythonic");
    expect(
      effectiveRecoverySetting("llama-json", undefined, { [RECOVER_ENV]: "" }),
    ).toBe("force:llama-json");
  });
});

describe("recoverySettingAsks", () => {
  it("finds a dialect in a name, a force: name or a list", () => {
    expect(recoverySettingAsks("llama-json", "llama-json")).toBe(true);
    expect(recoverySettingAsks("force:llama-json", "llama-json")).toBe(true);
    expect(recoverySettingAsks("qwen-xml, llama-json", "llama-json")).toBe(
      true,
    );
    expect(recoverySettingAsks("qwen-xml", "llama-json")).toBe(false);
    expect(recoverySettingAsks("", "llama-json")).toBe(false);
    expect(recoverySettingAsks(undefined, "llama-json")).toBe(false);
  });
});
