import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditTrail } from "./audit/trail";
import { readAuditFile } from "./audit/writer";
import type { RuleSourcesInput } from "./effectiveRules";
import { readUserConfigFile } from "./readRuleSources";
import {
  analyzeRule,
  broadReason,
  CONFIRM_PHRASE,
  lineDiff,
  validateRuleText,
} from "./ruleAnalysis";
import {
  applyToolRuleOp,
  clearUndoForTests,
  editToolRule,
  sampleCallFor,
  undoToolRuleChange,
  type EditDeps,
  type ToolRuleEdit,
} from "./ruleEditor";
import { isPolicyFilePath } from "./selfProtect";
import { testToolCall } from "./testToolCall";

const HOME = process.platform === "win32" ? "C:/Users/dev" : "/home/dev";

let dir: string;
let file: string;
let auditDir: string;
let sources: RuleSourcesInput;
let deps: EditDeps;

const SAMPLE = `name: test
version: 1.0.0
# my rules
toolPermissions:
  deny:
    - runTerminalCommand(terraform apply*) # never
  allow:
    - runTerminalCommand(npm test*)
`;

function edit(over: Partial<ToolRuleEdit>): ToolRuleEdit {
  return {
    op: "add",
    decision: "ask",
    rule: "runTerminalCommand(git push*)",
    source: "permissions-page",
    ...over,
  };
}

beforeEach(() => {
  clearUndoForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-editor-"));
  file = path.join(dir, "config.yaml");
  auditDir = path.join(dir, "audit");
  fs.writeFileSync(file, SAMPLE);
  sources = {};
  deps = {
    file,
    sources: () => ({
      ...sources,
      user: readUserConfigFile(file).permissions,
    }),
    audit: new AuditTrail({ dir: auditDir, enabled: true }),
    home: HOME,
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("validation", () => {
  it("refuses text the engine cannot read", () => {
    expect(validateRuleText("", "allow")).toBeDefined();
    expect(validateRuleText("*", "allow")).toBeDefined();
    expect(validateRuleText("runTerminalCommand()", "allow")).toBeDefined();
    expect(validateRuleText("a\nb", "allow")).toBeDefined();
    expect(validateRuleText("readFile(\u202esrc)", "allow")).toBeDefined();
    expect(validateRuleText("x".repeat(600), "allow")).toBeDefined();
    expect(validateRuleText("runTerminalCommand(npm test*)", "allow")).toBe(
      undefined,
    );
  });

  it("an invalid rule writes nothing", () => {
    const res = editToolRule(edit({ rule: "not a rule!" }), deps);
    expect(res.result).toBe("invalid");
    expect(fs.readFileSync(file, "utf8")).toBe(SAMPLE);
  });
});

describe("friction", () => {
  const broad = (rule: string) => broadReason("allow", rule, HOME);

  it("flags allow rules that match everything or a broad wildcard", () => {
    expect(broad("runTerminalCommand")).toBeDefined();
    expect(broad("runTerminalCommand(*)")).toBeDefined();
    expect(broad("runTerminalCommand(**)")).toBeDefined();
    expect(broad("runTerminalCommand(* --version)")).toBeDefined();
    expect(broad("runTerminalCommand(n*)")).toBeDefined();
    expect(broad("runTerminalCommand(bash*)")).toBeDefined();
    expect(broad("runTerminalCommand(sudo rm*)")).toBeDefined();
    expect(broad("mcp__*")).toBeDefined();
    expect(broad("fetchUrl(https://*)")).toBeDefined();
    expect(broad("readFile(**)")).toBeDefined();
    expect(broad("readFile(/**)")).toBeDefined();
    expect(broad("readFile(~/**)")).toBeDefined();
    expect(broad("readFile(~/.ssh/id_rsa)")).toBeDefined();
    expect(broad(`readFile(${HOME}/.aws/**)`)).toBeDefined();
    expect(broad("writeFile(**/*)")).toBeDefined();
  });

  it("leaves narrow rules alone", () => {
    expect(broad("runTerminalCommand(npm test*)")).toBeUndefined();
    expect(broad("readFile(src/**)")).toBeUndefined();
    expect(broad("writeFile(src/**/*.ts)")).toBeUndefined();
    expect(broad("mcp__github__create_issue")).toBeUndefined();
    expect(broad("fetchUrl(https://example.com/*)")).toBeUndefined();
  });

  it("never treats a wide Never or Ask as broad", () => {
    expect(broadReason("deny", "runTerminalCommand(*)", HOME)).toBeUndefined();
    expect(broadReason("ask", "readFile(**)", HOME)).toBeUndefined();
  });

  it("a broad Always needs the typed phrase and is not written without it", () => {
    const rule = "runTerminalCommand(*)";
    const first = editToolRule(edit({ decision: "allow", rule }), deps);
    expect(first.result).toBe("needs-confirmation");
    expect(first.analysis?.friction).toBe("typed");
    expect(fs.readFileSync(file, "utf8")).toBe(SAMPLE);

    const click = editToolRule(
      edit({ decision: "allow", rule, confirm: "yes" }),
      deps,
    );
    expect(click.result).toBe("needs-confirmation");

    const done = editToolRule(
      edit({ decision: "allow", rule, confirm: CONFIRM_PHRASE }),
      deps,
    );
    expect(done.result).toBe("added");
    expect(readUserConfigFile(file).permissions?.allow).toContain(rule);
  });

  it("removing a Never needs a confirmation; removing an Always does not", () => {
    const never = edit({
      op: "remove",
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
    });
    expect(editToolRule(never, deps).result).toBe("needs-confirmation");
    expect(editToolRule({ ...never, confirm: "yes" }, deps).result).toBe(
      "removed",
    );
    const always = edit({
      op: "remove",
      decision: "allow",
      rule: "runTerminalCommand(npm test*)",
    });
    expect(editToolRule(always, deps).result).toBe("removed");
  });

  it("moving a rule to a looser list needs a confirmation", () => {
    const move = edit({
      op: "update",
      decision: "deny",
      rule: "runTerminalCommand(terraform apply*)",
      newDecision: "ask",
    });
    expect(editToolRule(move, deps).result).toBe("needs-confirmation");
    expect(editToolRule({ ...move, confirm: "yes" }, deps).result).toBe(
      "updated",
    );
    const cfg = readUserConfigFile(file).permissions;
    expect(cfg?.ask).toEqual(["runTerminalCommand(terraform apply*)"]);
    expect(cfg?.deny).toBeUndefined();
  });
});

describe("warnings", () => {
  it("says an Always rule is dead under a Never", () => {
    const a = analyzeRule({
      decision: "allow",
      rule: "runTerminalCommand(terraform apply -auto-approve)",
      peers: [
        {
          decision: "deny",
          raw: "runTerminalCommand(terraform apply*)",
          owner: "your rule",
        },
      ],
      home: HOME,
    });
    expect(a.warnings.map((w) => w.kind)).toContain("shadowed");
    expect(a.warnings.find((w) => w.kind === "shadowed")?.message).toContain(
      "never take effect",
    );
  });

  it("says a more specific Never carves a part out of an Always", () => {
    const a = analyzeRule({
      decision: "allow",
      rule: "runTerminalCommand(git push*)",
      peers: [
        {
          decision: "deny",
          raw: "runTerminalCommand(git push --force*)",
          owner: "your rule",
        },
      ],
      home: HOME,
    });
    expect(a.warnings.map((w) => w.kind)).toContain("carved-out");
  });

  it("says a new Never kills an Always of yours", () => {
    const a = analyzeRule({
      decision: "deny",
      rule: "runTerminalCommand(npm*)",
      peers: [
        {
          decision: "allow",
          raw: "runTerminalCommand(npm test*)",
          owner: "your rule",
        },
      ],
      home: HOME,
    });
    expect(a.warnings.map((w) => w.kind)).toContain("dead");
  });

  it("reports duplicates and the same rule in another list", () => {
    const dup = editToolRule(
      edit({
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
      }),
      deps,
    );
    expect(dup.result).toBe("exists");
    const also = analyzeRule({
      decision: "allow",
      rule: "runTerminalCommand(terraform apply*)",
      peers: [
        {
          decision: "deny",
          raw: "runTerminalCommand(terraform apply*)",
          owner: "your rule",
        },
      ],
      home: HOME,
    });
    expect(also.warnings.map((w) => w.kind)).toContain("also-listed");
  });
});

describe("writing", () => {
  it("adds a rule, keeps comments and reports the diff", () => {
    const res = editToolRule(edit({}), deps);
    expect(res.result).toBe("added");
    expect(res.undoable).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# my rules");
    expect(text).toContain("# never");
    expect(text).toContain("runTerminalCommand(git push*)");
    expect(res.diff?.some((l) => l.kind === "add")).toBe(true);
    expect(res.afterHash).not.toBe(res.beforeHash);
  });

  it("a dry run writes nothing and returns the diff, analysis and tester verdict", () => {
    const res = editToolRule(
      edit({
        decision: "allow",
        rule: "runTerminalCommand(git status*)",
        dryRun: true,
      }),
      deps,
    );
    expect(res.result).toBe("preview");
    expect(res.diff?.some((l) => l.text.includes("git status"))).toBe(true);
    expect(res.verdict?.probe).toBe("git status");
    expect(res.verdict?.after.decision).toBe("allow");
    expect(fs.readFileSync(file, "utf8")).toBe(SAMPLE);
  });

  it("edits the text of a rule in place", () => {
    const res = editToolRule(
      edit({
        op: "update",
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
        newRule: "runTerminalCommand(npm run test*)",
      }),
      deps,
    );
    expect(res.result).toBe("updated");
    expect(readUserConfigFile(file).permissions?.allow).toEqual([
      "runTerminalCommand(npm run test*)",
    ]);
  });

  it("removes the key when its list empties", () => {
    editToolRule(
      edit({
        op: "remove",
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
      }),
      deps,
    );
    expect(fs.readFileSync(file, "utf8")).not.toContain("allow:");
  });

  it("a rule that is not there is not-found", () => {
    const res = editToolRule(
      edit({ op: "remove", decision: "allow", rule: "readFile(x)" }),
      deps,
    );
    expect(res.result).toBe("not-found");
  });

  it("refuses to write when the file changed since the caller read it", () => {
    const hash = readUserConfigFile(file).hash;
    fs.appendFileSync(file, "\n# edited by hand\n");
    const res = editToolRule(edit({ baseHash: hash }), deps);
    expect(res.result).toBe("conflict");
    expect(fs.readFileSync(file, "utf8")).not.toContain("git push");
  });

  it("names a failed write instead of claiming success", () => {
    // A path whose parent is a file cannot be written or backed up
    const blocked = path.join(dir, "config.yaml", "nested.yaml");
    const res = editToolRule(edit({}), { ...deps, file: blocked });
    expect(["no-config", "broken", "failed"]).toContain(res.result);
    expect(res.error).toBeTruthy();
  });
});

describe("a broken or missing file", () => {
  it("is an error state, never no rules, and is not written", () => {
    const broken = "name: x\ntoolPermissions:\n  allow: [unclosed\n";
    fs.writeFileSync(file, broken);
    const state = readUserConfigFile(file);
    expect(state.state).toBe("broken");
    expect(state.permissions).toBeUndefined();
    const res = editToolRule(edit({}), deps);
    expect(res.result).toBe("broken");
    expect(res.error).toContain("Nothing was changed");
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
  });

  it("toolPermissions of the wrong shape is broken", () => {
    fs.writeFileSync(file, "name: x\ntoolPermissions:\n  allow: nope\n");
    expect(readUserConfigFile(file).state).toBe("broken");
    fs.writeFileSync(file, "name: x\ntoolPermissions:\n  allow: [1, 2]\n");
    expect(readUserConfigFile(file).state).toBe("broken");
  });

  it("a missing file is no-config", () => {
    fs.rmSync(file);
    expect(readUserConfigFile(file).state).toBe("missing");
    expect(editToolRule(edit({}), deps).result).toBe("no-config");
  });
});

describe("adopt", () => {
  const folderAllow = "runTerminalCommand(make build*)";

  beforeEach(() => {
    sources = {
      folder: [
        {
          file: "/ws/.continue/rules.yaml",
          permissions: { allow: [folderAllow] },
        },
      ],
      assistantAllow: "ignored",
    };
  });

  it("shows the verdict before and after, then copies the rule to your file", () => {
    const preview = editToolRule(
      edit({ op: "adopt", decision: "allow", rule: folderAllow, dryRun: true }),
      deps,
    );
    expect(preview.result).toBe("preview");
    expect(preview.verdict?.probe).toBe("make build");
    expect(preview.verdict?.before.decision).not.toBe("allow");
    expect(preview.verdict?.after.decision).toBe("allow");

    const res = editToolRule(
      edit({ op: "adopt", decision: "allow", rule: folderAllow }),
      deps,
    );
    expect(res.result).toBe("adopted");
    expect(readUserConfigFile(file).permissions?.allow).toContain(folderAllow);
  });

  it("refuses a rule that is not in an assistant or workspace file", () => {
    const res = editToolRule(
      edit({ op: "adopt", decision: "allow", rule: "readFile(src/**)" }),
      deps,
    );
    expect(res.result).toBe("not-found");
  });

  it("applies the same friction to a broad adopted rule", () => {
    sources = {
      folder: [
        {
          file: "/ws/x.yaml",
          permissions: { allow: ["runTerminalCommand(*)"] },
        },
      ],
    };
    const res = editToolRule(
      edit({ op: "adopt", decision: "allow", rule: "runTerminalCommand(*)" }),
      deps,
    );
    expect(res.result).toBe("needs-confirmation");
  });

  it("the rule takes effect only after adoption", () => {
    const verdict = () =>
      testToolCall({
        tool: "runTerminalCommand",
        command: "make build",
        sources: deps.sources(),
      }).decision;
    expect(verdict()).not.toBe("allow");
    editToolRule(
      edit({ op: "adopt", decision: "allow", rule: folderAllow }),
      deps,
    );
    expect(verdict()).toBe("allow");
  });
});

describe("the audit event", () => {
  const events = () =>
    (fs.existsSync(auditDir)
      ? (fs.readdirSync(auditDir, { recursive: true }) as string[])
      : []
    )
      .filter((f) => String(f).endsWith(".jsonl"))
      .flatMap((f) => readAuditFile(path.join(auditDir, String(f))))
      .filter((r) => r.ev === "policy") as any[];

  it("records who, what, the hashes and loosens, with the rule masked", () => {
    const before = readUserConfigFile(file).hash;
    editToolRule(
      edit({
        decision: "allow",
        rule: "runTerminalCommand(deploy --token=sk-ant-abcdefghijklmnopqrstuvwxyz*)",
      }),
      deps,
    );
    const [ev] = events();
    expect(ev.source).toBe("permissions-page");
    expect(ev.op).toBe("add");
    expect(ev.decision).toBe("allow");
    expect(ev.loosens).toBe(true);
    expect(ev.beforeHash).toBe(before);
    expect(ev.afterHash).toBe(readUserConfigFile(file).hash);
    expect(JSON.stringify(ev)).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("records the typed confirmation, a removal and an undo", () => {
    editToolRule(
      edit({
        decision: "allow",
        rule: "runTerminalCommand(*)",
        confirm: CONFIRM_PHRASE,
      }),
      deps,
    );
    editToolRule(
      edit({
        op: "remove",
        decision: "allow",
        rule: "runTerminalCommand(npm test*)",
      }),
      deps,
    );
    undoToolRuleChange({ file, audit: deps.audit, source: "cli" });
    const ops = events().map((e) => `${e.op}:${e.confirmed ?? ""}`);
    expect(ops).toEqual(["add:typed", "remove:", "undo:"]);
  });

  it("a failed or refused change writes no event", () => {
    editToolRule(edit({ rule: "nope!" }), deps);
    editToolRule(
      edit({ decision: "allow", rule: "runTerminalCommand(*)" }),
      deps,
    );
    expect(events()).toEqual([]);
  });
});

describe("undo", () => {
  it("puts back the exact earlier text when the file is unchanged since", () => {
    editToolRule(edit({}), deps);
    const res = undoToolRuleChange({
      file,
      audit: deps.audit,
      source: "permissions-page",
    });
    expect(res.result).toBe("undone");
    expect(fs.readFileSync(file, "utf8")).toBe(SAMPLE);
    expect(undoToolRuleChange({ file, source: "cli" }).result).toBe(
      "nothing-to-undo",
    );
  });

  it("does not restore a file that changed since (hash compare)", () => {
    editToolRule(edit({}), deps);
    fs.appendFileSync(file, "# hand edit\n");
    const res = undoToolRuleChange({ file, source: "permissions-page" });
    expect(res.result).toBe("conflict");
    expect(fs.readFileSync(file, "utf8")).toContain("# hand edit");
    expect(fs.readFileSync(file, "utf8")).toContain("git push");
  });

  it("undoes several changes, newest first", () => {
    editToolRule(edit({ rule: "runTerminalCommand(a*)" }), deps);
    editToolRule(edit({ rule: "runTerminalCommand(b*)" }), deps);
    undoToolRuleChange({ file, source: "cli" });
    expect(readUserConfigFile(file).permissions?.ask).toEqual([
      "runTerminalCommand(a*)",
    ]);
  });
});

describe("helpers", () => {
  it("applyToolRuleOp leaves other keys and the auto block alone", () => {
    const cfg: any = {
      name: "x",
      version: "1",
      toolPermissions: { allow: ["a(1)"], auto: { limits: {} } },
    };
    const { config } = applyToolRuleOp(cfg, {
      op: "remove",
      decision: "allow",
      rule: "a(1)",
    });
    expect(config.toolPermissions).toEqual({ auto: { limits: {} } });
  });

  it("makes a sample call from a pattern", () => {
    expect(sampleCallFor("runTerminalCommand(npm test*)")).toMatchObject({
      field: "command",
      value: "npm test",
    });
    expect(sampleCallFor("readFile(src/**/*.ts)")?.value).toBe("src/x/x.ts");
    expect(sampleCallFor("runTerminalCommand")).toBeUndefined();
  });

  it("lineDiff shows added and removed lines with context", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nX\nd\ne\nf", 1);
    expect(d.filter((l) => l.kind !== "same").map((l) => l.text)).toEqual([
      "c",
      "X",
    ]);
  });
});

describe("the model cannot reach the write path", () => {
  it("config.yaml and permissions.yaml are locked policy files", () => {
    for (const p of [
      "/home/dev/.continue/config.yaml",
      "/home/dev/.continuous/config.yaml",
      "/home/dev/.continuous/permissions.yaml",
    ]) {
      expect(isPolicyFilePath(p)).toBe(true);
    }
  });

  it("no built-in tool is named for settings or permissions", async () => {
    const { BuiltInToolNames } = await import("../builtIn");
    for (const name of Object.values(BuiltInToolNames)) {
      expect(String(name)).not.toMatch(/config|permission|policy|setting/i);
    }
  });
});
