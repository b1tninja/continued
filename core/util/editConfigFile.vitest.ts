import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";

const SOURCE = `# my config
name: Local
models:
  - name: A # keep
    provider: openai
    model: gpt-5
`;

describe("editConfigFile (config.yaml)", () => {
  let dir: string;
  let editConfigFile: typeof import("./paths").editConfigFile;
  let cfgPath: string;
  const identityJson = (c: any) => c;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-edit-"));
    process.env.CONTINUE_GLOBAL_DIR = dir;
    vi.resetModules();
    ({ editConfigFile } = await import("./paths"));
    cfgPath = path.join(dir, "config.yaml");
    fs.writeFileSync(cfgPath, SOURCE);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps comments when a model is added", () => {
    editConfigFile(identityJson, (c: any) => ({
      ...c,
      models: [...c.models, { name: "B", provider: "bedrock", model: "x" }],
    }));
    const out = fs.readFileSync(cfgPath, "utf8");
    expect(out).toContain("# my config");
    expect(out).toContain("# keep");
    expect(YAML.parse(out).models.map((m: any) => m.name)).toEqual(["A", "B"]);
  });

  it("writes a .bak of the original once, and does not overwrite it later", () => {
    editConfigFile(identityJson, (c: any) => ({ ...c, name: "One" }));
    editConfigFile(identityJson, (c: any) => ({ ...c, name: "Two" }));
    expect(fs.readFileSync(`${cfgPath}.bak`, "utf8")).toBe(SOURCE);
    expect(YAML.parse(fs.readFileSync(cfgPath, "utf8")).name).toBe("Two");
  });

  it("does not write when nothing changes", () => {
    const before = fs.statSync(cfgPath).mtimeMs;
    editConfigFile(identityJson, (c: any) => c);
    expect(fs.existsSync(`${cfgPath}.bak`)).toBe(false);
    expect(fs.statSync(cfgPath).mtimeMs).toBe(before);
  });

  it("leaves an unparsable file untouched", () => {
    const bad = "models: [oops\n  - : :\n";
    fs.writeFileSync(cfgPath, bad);
    editConfigFile(identityJson, (c: any) => ({ ...c, name: "x" }));
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(bad);
    expect(fs.existsSync(`${cfgPath}.bak`)).toBe(false);
  });

  it("leaves no temp files behind", () => {
    editConfigFile(identityJson, (c: any) => ({ ...c, name: "One" }));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes through a symlinked config.yaml instead of replacing the link", (ctx) => {
    const real = path.join(dir, "dotfiles-config.yaml");
    fs.renameSync(cfgPath, real);
    try {
      fs.symlinkSync(real, cfgPath);
    } catch {
      // Creating symlinks needs privileges on Windows; nothing to check there.
      ctx.skip();
      return;
    }
    editConfigFile(identityJson, (c: any) => ({ ...c, name: "Linked" }));
    expect(fs.lstatSync(cfgPath).isSymbolicLink()).toBe(true);
    expect(YAML.parse(fs.readFileSync(real, "utf8")).name).toBe("Linked");
  });
});
