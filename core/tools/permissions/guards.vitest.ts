import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createNewFileTool, editFileTool, readFileTool } from "../definitions";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import { GUARDS, guardsOn, type GuardSettings } from "./guards";
import { POLICY_PRESETS, type PolicyLevels } from "./policy";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  POLICY_FILE_KEYS,
} from "./settingsFile";

const ALLOW = "allowedWithoutPermission";
const ASK = "allowedWithPermission";
const OFF = "disabled";

const CWD = "/home/me/proj";
const OUTSIDE = "/srv/other/docs/x.md";
const INSIDE = `${CWD}/src/new.ts`;

function call(
  tool: typeof createNewFileTool | typeof editFileTool | typeof readFileTool,
  filepath: string,
  levels: PolicyLevels,
  guards?: GuardSettings,
) {
  const within = filepath.startsWith(CWD);
  return evaluateToolPolicyWithRules({
    tool,
    toolName: tool.function.name,
    basePolicy: tool.defaultToolPolicy,
    parsedArgs: { filepath },
    processedArgs: {
      resolvedPath: {
        uri: pathToFileURL(filepath).href,
        displayPath: filepath,
        isAbsolute: true,
        isWithinWorkspace: within,
      },
    },
    cwd: CWD,
    workspaceDirs: [CWD],
    shell: "bash",
    platform: "posix",
    home: "/home/me",
    permissions: undefined,
    approval: { levels, ...(guards ? { guards } : {}) },
  } as EvaluateInput);
}

const IDGAF = POLICY_PRESETS.idgaf.levels;
const CAREFUL = POLICY_PRESETS.careful.levels;
const GUARD: GuardSettings = { "edits-outside-workspace": true };

describe("guard: do not edit files outside the workspace", () => {
  it("IDGAF + the guard: an edit outside is refused, never asked, and says why", () => {
    for (const tool of [createNewFileTool, editFileTool]) {
      const r = call(tool, OUTSIDE, IDGAF, GUARD);
      // Refused, not held for a person: IDGAF never asks, and the run goes on
      expect(r.policy, tool.function.name).toBe(OFF);
      expect(r.policy).not.toBe(ASK);
      expect(r.source).toBe("floor");
      expect(r.rule).toBe("guards.edits-outside-workspace");
      expect(r.reason).toContain("Do not edit files outside the workspace");
      expect(r.reason).toContain(OUTSIDE);
    }
  });

  it("IDGAF + the guard: the same edit inside the workspace runs", () => {
    const r = call(createNewFileTool, INSIDE, IDGAF, GUARD);
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("idgaf");
  });

  it("plain IDGAF: both run, no guard is turned on for the person", () => {
    expect(call(createNewFileTool, OUTSIDE, IDGAF).policy).toBe(ALLOW);
    expect(call(createNewFileTool, INSIDE, IDGAF).policy).toBe(ALLOW);
    // A guard switched off is the same as none
    expect(
      call(createNewFileTool, OUTSIDE, IDGAF, {
        "edits-outside-workspace": false,
      }).policy,
    ).toBe(ALLOW);
  });

  it("binds at every level, not only IDGAF", () => {
    expect(call(editFileTool, OUTSIDE, CAREFUL, GUARD).policy).toBe(OFF);
    expect(
      call(editFileTool, OUTSIDE, POLICY_PRESETS.handsOff.levels, GUARD).policy,
    ).toBe(OFF);
  });

  it("covers File edits only: a read outside is left to its own area", () => {
    const r = call(readFileTool, OUTSIDE, IDGAF, GUARD);
    expect(r.policy).toBe(ALLOW);
  });
});

describe("guards in permissions.yaml", () => {
  it("are read from the person's file, each off unless written on", () => {
    expect(parsePolicyFile("levels: {}\n").settings.guards).toBeUndefined();
    const { settings, notices } = parsePolicyFile(
      "guards:\n  edits-outside-workspace: on\n  no-such-guard: on\n",
    );
    expect(settings.guards).toEqual({ "edits-outside-workspace": true });
    expect(notices).toContain(
      "guards.no-such-guard: there is no guard with that id.",
    );
    expect(guardsOn(settings.guards)).toEqual(["edits-outside-workspace"]);
  });

  it("a guard written with a value that is not on or off is reported and stays off", () => {
    const { settings, notices } = parsePolicyFile(
      "guards:\n  edits-outside-workspace: maybe\n",
    );
    expect(settings.guards).toEqual({});
    expect(notices).toContain("guards.edits-outside-workspace: use on or off.");
  });

  it("is written as `on`, removed when off, and leaves the rest of the file as it was", () => {
    const before =
      "# mine\nlevels:\n  tools: cautious # keep\nallow:\n  - Bash(npm test)\n";
    const on = applyPolicyUpdate(before, { guards: GUARD });
    expect(on).toBe(
      "# mine\nlevels:\n  tools: cautious # keep\nallow:\n  - Bash(npm test)\nguards:\n  edits-outside-workspace: on\n",
    );
    const off = applyPolicyUpdate(on, {
      guards: { "edits-outside-workspace": false },
    });
    expect(off).toBe(before);
  });

  it("is a key the CLI's loader accepts, so the file is not read as broken", () => {
    expect(POLICY_FILE_KEYS).toContain("guards");
  });

  it("every guard has a label and a description", () => {
    for (const g of GUARDS) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(0);
    }
  });
});
