import fs from "fs";
import os from "os";
import path from "path";

import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, describe, expect, it } from "vitest";

import { handleSlashCommands } from "../slashCommands.js";

import { setAutoReviewEnabled } from "./coreRules.js";
import { evaluateWithCoreRules } from "./coreRules.js";
import { loadPermissionsYaml } from "./permissionsYamlLoader.js";
import {
  approvalExtras,
  describePolicy,
  effectiveLevels,
  getPolicyLevels,
  levelsForAutonomy,
  loadPolicyFile,
  parsePolicySpec,
  policyIsDefault,
  resetPolicyLevels,
  savePolicyFile,
  setPolicyLevels,
  toolLevelsAreDefault,
} from "./policyLevels.js";

afterEach(() => {
  resetPolicyLevels();
  setAutoReviewEnabled(false);
});

describe("parsePolicySpec", () => {
  it("takes a preset by name, in any case", () => {
    const r = parsePolicySpec("YOLO");
    expect(r.ok && Object.values(r.levels)).toEqual(Array(5).fill("yolo"));
    const careful = parsePolicySpec("careful");
    expect(careful.ok && careful.levels).toEqual(DEFAULT_POLICY_LEVELS);
  });

  it("takes area=level pairs on top of the current levels", () => {
    const r = parsePolicySpec("tools=permissive,plan=manual");
    expect(r.ok && r.levels).toEqual({
      ...DEFAULT_POLICY_LEVELS,
      tools: "permissive",
      plan: "manual",
    });
  });

  it("a bare level sets every area, and idgaf is yolo", () => {
    const r = parsePolicySpec("idgaf");
    expect(r.ok && Object.values(r.levels)).toEqual(Array(5).fill("yolo"));
  });

  it("refuses what it cannot read, naming it", () => {
    expect(parsePolicySpec("tools=sometimes")).toMatchObject({
      ok: false,
      error: expect.stringContaining('"sometimes"'),
    });
    expect(parsePolicySpec("colour=manual")).toMatchObject({ ok: false });
    expect(parsePolicySpec("whatever")).toMatchObject({ ok: false });
    expect(parsePolicySpec("  ")).toMatchObject({ ok: false });
  });
});

describe("effectiveLevels", () => {
  it("is the levels the person set", () => {
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "manual" });
    expect(effectiveLevels("normal").tools).toBe("manual");
  });

  it("--auto is YOLO on the tool areas and a plan that goes on", () => {
    const l = effectiveLevels("auto");
    expect([l.context, l.tools, l.edits]).toEqual(["yolo", "yolo", "yolo"]);
    expect(l.plan).toBe("permissive");
  });

  it("--auto-review makes Cautious Automatic, and keeps a level set higher", () => {
    setAutoReviewEnabled(true);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" });
    const l = effectiveLevels("normal");
    expect(l.tools).toBe("permissive");
    expect(l.context).toBe("permissive");
    expect(l.edits).toBe("manual");
  });

  it("the defaults leave core's engine out of calls that have no rules", () => {
    expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(true);
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" });
    expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(false);
  });
});

describe("levelsForAutonomy", () => {
  it("maps the old level names onto Plan edits and Questions", () => {
    expect(levelsForAutonomy("supervised")).toEqual({
      plan: "manual",
      questions: "manual",
    });
    expect(levelsForAutonomy("idgaf")).toEqual({
      plan: "permissive",
      questions: "yolo",
    });
  });
});

describe("the levels reach core's engine", () => {
  const run = (
    levels: Partial<typeof DEFAULT_POLICY_LEVELS>,
    command: string,
  ) =>
    evaluateWithCoreRules({
      cliToolName: "Bash",
      args: { command },
      cliPermission: "ask",
      assistantPermissions: undefined,
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, ...levels } },
      isHeadless: false,
    });

  it("Permissive runs a command the CLI would ask about", async () => {
    expect(
      await run({ tools: "permissive" }, "git push origin main"),
    ).toMatchObject({ decision: "allow", by: "rules" });
  });

  it("YOLO runs it, and Manual still asks", async () => {
    expect((await run({ tools: "yolo" }, "git push"))?.decision).toBe("allow");
    expect((await run({ tools: "manual" }, "git push"))?.decision).toBe("ask");
  });

  it("at the default levels a command that only reads runs, and others still ask", async () => {
    expect(await run({}, "ls -la")).toMatchObject({
      decision: "allow",
      by: "rules",
    });
    expect(await run({}, "cat a.txt | sort | uniq")).toMatchObject({
      decision: "allow",
    });
    expect((await run({}, "npm test"))?.decision).toBe("ask");
    expect((await run({}, "ls > out.txt"))?.decision).toBe("ask");
  });

  it("a read-only command that names a credentials file still asks", async () => {
    expect((await run({}, "cat ~/.aws/credentials"))?.decision).toBe("ask");
  });

  it("without levels or rules the CLI keeps its own result", async () => {
    expect(
      await evaluateWithCoreRules({
        cliToolName: "Bash",
        args: { command: "ls" },
        cliPermission: "ask",
        assistantPermissions: undefined,
        isHeadless: false,
      }),
    ).toBeUndefined();
  });
});

describe("/policy", () => {
  it("shows the five areas", async () => {
    const r = await handleSlashCommands("/policy", {} as never);
    expect(r?.output).toContain("Context use");
    expect(r?.output).toContain("Questions");
    expect(r?.output).toContain("Careful");
  });

  it("sets levels, and says what it did not understand", async () => {
    await handleSlashCommands("/policy tools=permissive", {} as never);
    expect(getPolicyLevels().tools).toBe("permissive");
    const bad = await handleSlashCommands("/policy tools=never", {} as never);
    expect(bad?.output).toContain('"never"');
    expect(getPolicyLevels().tools).toBe("permissive");
  });

  it("describePolicy names a custom mix", () => {
    expect(
      describePolicy({ ...DEFAULT_POLICY_LEVELS, tools: "yolo" }).join("\n"),
    ).toContain("Custom");
  });
});

describe("the shared settings file", () => {
  const withFile = (text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, text);
    return { dir, file };
  };

  it("loads levels, switches and the floor, and reports what it cannot use", () => {
    const { dir, file } = withFile(
      "allow:\n  - Bash(ls)\nlevels:\n  tools: permissive\n  plan: yolo\nbuiltin:\n  protect-network-paths: off\nfloor:\n  - Bash(rm -rf *)\n",
    );
    try {
      const notices = loadPolicyFile(file);
      expect(getPolicyLevels().tools).toBe("permissive");
      // yolo is for one session only
      expect(getPolicyLevels().plan).toBe(DEFAULT_POLICY_LEVELS.plan);
      expect(notices.join("\n")).toContain("levels.plan: yolo");
      expect(approvalExtras()).toEqual({
        builtin: { "protect-network-paths": false },
        floor: ["Bash(rm -rf *)"],
      });
      expect(policyIsDefault(effectiveLevels("normal"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a floor or a switched-off built-in is enough to run core's engine", () => {
    const { dir, file } = withFile("floor:\n  - Bash(rm -rf *)\n");
    try {
      loadPolicyFile(file);
      expect(toolLevelsAreDefault(effectiveLevels("normal"))).toBe(true);
      expect(policyIsDefault(effectiveLevels("normal"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saving keeps the CLI's own lists and never writes YOLO", () => {
    const { dir, file } = withFile("allow:\n  - Bash(ls)\n");
    try {
      setPolicyLevels({
        ...DEFAULT_POLICY_LEVELS,
        tools: "yolo",
        edits: "permissive",
      });
      savePolicyFile(file);
      const text = fs.readFileSync(file, "utf-8");
      expect(text).toContain("Bash(ls)");
      expect(text).not.toContain("yolo");
      expect(text).toContain("edits: permissive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI's own loader still reads a file that has policy keys", () => {
    const { dir, file } = withFile(
      "allow:\n  - Bash(ls)\nlevels:\n  tools: manual\nquestions:\n  delivery: wait\n",
    );
    try {
      expect(loadPermissionsYaml(file)).toMatchObject({ allow: ["Bash(ls)"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
