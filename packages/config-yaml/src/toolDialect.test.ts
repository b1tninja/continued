import {
  modelSchema,
  RECOVER_ENV,
  RECOVER_FIELD,
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
      "toolDialect must be one of: auto, native, qwen-xml, pythonic, llama-json, hermes-json, glm-xml, off",
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
