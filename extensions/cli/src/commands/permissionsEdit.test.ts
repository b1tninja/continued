import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { readAuditFile } from "core/tools/permissions/audit/writer.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { permissionsCommand } from "./permissions.js";

let dir: string;
let file: string;
let audit: AuditTrail;
let out: string[];
let err: string[];

const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});
const opts = (extra: Record<string, unknown> = {}) => ({
  configFile: file,
  permissionsFile: path.join(dir, "permissions.yaml"),
  cwd: dir,
  audit,
  ...extra,
});
const read = () => fs.readFileSync(file, "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-edit-"));
  file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    "name: t\nversion: 1.0.0\ntoolPermissions:\n  deny:\n    - runTerminalCommand(terraform apply*) # keep\n",
  );
  audit = new AuditTrail({ dir: path.join(dir, "audit"), enabled: true });
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("continuous permissions add", () => {
  it("adds a rule with the owner's words and keeps comments", () => {
    const code = permissionsCommand(
      "add",
      ["ask", "runTerminalCommand(git push*)"],
      opts(),
      io(),
    );
    expect(code).toBe(0);
    expect(read()).toContain("ask:");
    expect(read()).toContain("# keep");
    expect(out.join("\n")).toContain("Done: added");
  });

  it("refuses a broad Always without the flag, then accepts it", () => {
    const args = ["always", "runTerminalCommand(*)"];
    expect(permissionsCommand("add", args, opts(), io())).toBe(2);
    expect(err.join("\n")).toContain("--yes-allow-everything");
    expect(read()).not.toContain("allow:");
    expect(
      permissionsCommand("add", args, opts({ yesAllowEverything: true }), io()),
    ).toBe(0);
    expect(read()).toContain("runTerminalCommand(*)");
  });

  it("--yes alone is not enough for a broad rule", () => {
    expect(
      permissionsCommand(
        "add",
        ["allow", "runTerminalCommand(*)"],
        opts({ yes: true }),
        io(),
      ),
    ).toBe(2);
  });

  it("a dry run shows the diff and writes nothing", () => {
    const before = read();
    const code = permissionsCommand(
      "add",
      ["always", "runTerminalCommand(git status*)"],
      opts({ dryRun: true }),
      io(),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("+ ");
    expect(out.join("\n")).toContain('For "git status"');
    expect(read()).toBe(before);
  });

  it("refuses an unreadable rule and a broken file", () => {
    expect(
      permissionsCommand("add", ["ask", "not a rule!"], opts(), io()),
    ).toBe(1);
    fs.writeFileSync(file, "name: [broken\n");
    expect(
      permissionsCommand("add", ["ask", "readFile(x)"], opts(), io()),
    ).toBe(1);
    expect(err.join("\n")).toContain("Nothing was changed");
    expect(read()).toBe("name: [broken\n");
  });

  it("writes a policy event to the audit trail", () => {
    permissionsCommand(
      "add",
      ["ask", "runTerminalCommand(git push*)"],
      opts(),
      io(),
    );
    const files = fs.readdirSync(path.join(dir, "audit"), {
      recursive: true,
    }) as string[];
    const jsonl = files.find((f) => String(f).endsWith(".jsonl"))!;
    const [ev] = readAuditFile(path.join(dir, "audit", String(jsonl)));
    expect(ev).toMatchObject({ ev: "policy", source: "cli", op: "add" });
  });
});

describe("continuous permissions remove", () => {
  it("needs --yes to remove a Never", () => {
    const args = ["runTerminalCommand(terraform apply*)"];
    expect(permissionsCommand("remove", args, opts(), io())).toBe(2);
    expect(read()).toContain("terraform apply");
    expect(permissionsCommand("remove", args, opts({ yes: true }), io())).toBe(
      0,
    );
    expect(read()).not.toContain("terraform apply");
  });

  it("a rule that is not there is an error", () => {
    expect(permissionsCommand("remove", ["readFile(nope)"], opts(), io())).toBe(
      1,
    );
  });
});

describe("continuous permissions adopt", () => {
  it("copies a workspace rule after showing its verdict", () => {
    const ws = path.join(dir, "ws.yaml");
    fs.writeFileSync(
      ws,
      "name: ws\nversion: 1.0.0\ntoolPermissions:\n  allow:\n    - runTerminalCommand(make build*)\n",
    );
    const code = permissionsCommand(
      "adopt",
      ["runTerminalCommand(make build*)"],
      opts({ from: ws }),
      io(),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('For "make build"');
    expect(read()).toContain("make build");
  });

  it("refuses a rule the file does not have, and needs --from", () => {
    const ws = path.join(dir, "ws.yaml");
    fs.writeFileSync(
      ws,
      "name: ws\ntoolPermissions:\n  allow:\n    - readFile(a)\n",
    );
    expect(
      permissionsCommand("adopt", ["readFile(b)"], opts({ from: ws }), io()),
    ).toBe(1);
    expect(permissionsCommand("adopt", ["readFile(a)"], opts(), io())).toBe(1);
  });
});
