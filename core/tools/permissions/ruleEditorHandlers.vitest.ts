import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearUndoForTests } from "./ruleEditor";
import { registerRuleEditorHandlers } from "./ruleEditorHandlers";

const state = vi.hoisted(() => ({ file: "" }));

vi.mock("../../util/paths", async (orig) => ({
  ...(await orig<typeof import("../../util/paths")>()),
  getConfigYamlPath: () => state.file,
}));
vi.mock("./audit/global", () => ({ getAuditTrail: () => undefined }));

const SAMPLE = `name: test
version: 1.0.0
toolPermissions:
  deny:
    - runTerminalCommand(terraform apply*)
  allow:
    - runTerminalCommand(npm test*)
`;

type Handler = (msg: { data: any }) => Promise<any>;

let dir: string;
const handlers = new Map<string, Handler>();
const reload = vi.fn(async () => {});
let confirm: ReturnType<typeof vi.fn>;

function register(withDialog = true) {
  handlers.clear();
  confirm = vi.fn().mockResolvedValue(true);
  registerRuleEditorHandlers(
    ((name: string, h: Handler) => handlers.set(name, h)) as never,
    {
      mergedRules: async () => undefined,
      cwd: async () => undefined,
      reload,
      ...(withDialog ? { confirmLoosening: confirm as never } : {}),
    },
  );
}

const call = (name: string, data: Record<string, unknown>) =>
  handlers.get(name)!({ data });
const text = () => fs.readFileSync(state.file, "utf8");

beforeEach(() => {
  clearUndoForTests();
  reload.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-handlers-"));
  state.file = path.join(dir, "config.yaml");
  fs.writeFileSync(state.file, SAMPLE);
  register();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a loosening waits for the IDE's own dialog", () => {
  it("shows the dialog for a new Always rule, then writes it", async () => {
    const res = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(make build*)",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/Add Always runTerminalCommand/);
    expect(res.result).toBe("added");
    expect(text()).toContain("make build");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the dialog is declined, whatever the page sent", async () => {
    confirm.mockResolvedValue(false);
    const before = text();
    const res = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(make build*)",
      confirm: "yes",
    });
    expect(res.result).toBe("refused");
    expect(res.error).toMatch(/nothing was changed/i);
    expect(text()).toBe(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("writes nothing when the host has no dialog (a loosening fails closed)", async () => {
    register(false);
    const before = text();
    const res = await call("config/removeToolRule", {
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
      confirm: "yes",
    });
    expect(res.result).toBe("refused");
    expect(text()).toBe(before);
  });

  it("a page cannot claim the confirmation itself", async () => {
    confirm.mockResolvedValue(false);
    const before = text();
    const res = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(make build*)",
      confirm: "allow everything",
      confirmedNatively: true,
      dryRun: false,
    });
    expect(res.result).toBe("refused");
    expect(text()).toBe(before);
  });

  it("removing a Never asks the dialog and replaces the page's checkbox", async () => {
    const res = await call("config/removeToolRule", {
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
    });
    expect(confirm.mock.calls[0][0]).toMatch(/Remove the Never rule/);
    expect(res.result).toBe("removed");
    expect(text()).not.toContain("terraform");
  });

  it("a broad rule still needs the typed phrase before the dialog is shown", async () => {
    const res = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(*)",
    });
    expect(res.result).toBe("needs-confirmation");
    expect(confirm).not.toHaveBeenCalled();
    const ok = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(*)",
      confirm: "allow everything",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ok.result).toBe("added");
  });

  it("a tightening and a dry run never open the dialog", async () => {
    await call("config/addToolRule", {
      decision: "ask",
      rule: "runTerminalCommand(git push*)",
    });
    await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(make*)",
      dryRun: true,
    });
    await call("config/removeToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(npm test*)",
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a dialog that throws is a no", async () => {
    confirm.mockRejectedValue(new Error("no window"));
    const res = await call("config/addToolRule", {
      decision: "allow",
      rule: "runTerminalCommand(make build*)",
    });
    expect(res.result).toBe("refused");
  });

  it("undoing an added Never is a loosening and asks; putting a Never back does not", async () => {
    await call("config/addToolRule", {
      decision: "deny",
      rule: "runTerminalCommand(rm -rf*)",
    });
    confirm.mockResolvedValue(false);
    const before = text();
    const refused = await call("config/undoToolRule", {});
    expect(refused.result).toBe("failed");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text()).toBe(before);

    confirm.mockClear();
    confirm.mockResolvedValue(true);
    expect((await call("config/undoToolRule", {})).result).toBe("undone");

    await call("config/removeToolRule", {
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
    });
    confirm.mockClear();
    expect((await call("config/undoToolRule", {})).result).toBe("undone");
    expect(confirm).not.toHaveBeenCalled();
  });
});
