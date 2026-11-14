import { act, fireEvent, screen, within } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_AREAS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PolicyControls } from "../../../../../components/PolicyControls";
import { MockIdeMessenger } from "../../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../../redux/store";
import { renderWithProviders } from "../../../../../util/test/render";
import { PermissionsSection } from "../PermissionsSection";

const report = listEffectiveRules({
  levels: DEFAULT_POLICY_LEVELS,
  user: {
    deny: ["runTerminalCommand(terraform apply*)"],
    ask: ["runTerminalCommand(git push*)"],
    allow: ["runTerminalCommand(npm test*)"],
  },
  folder: [
    {
      file: "/repo/.continue/rules.yaml",
      permissions: { allow: ["runTerminalCommand(curl*)"] },
    },
  ],
  userFile: {
    path: "/home/me/.continuous/config.yaml",
    state: "ok",
    hash: "h1",
  },
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

describe("Custom… on every policy control", () => {
  it("is an option of the preset and of each area, reached by keyboard, and opens the editor", async () => {
    const { user } = await renderWithProviders(
      <>
        <PolicyControls />
        <Where />
      </>,
    );
    const tick = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    // Open from the keyboard, go to the last option, choose it with Enter
    const choose = async (button: HTMLElement, testId: string) => {
      await act(async () => button.focus());
      await user.keyboard("{ArrowDown}");
      await tick();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await user.keyboard("{End}");
      await tick();
      const option = screen.getByTestId(testId);
      expect(option.getAttribute("role")).toBe("option");
      expect(option.textContent).toContain("Custom…");
      await user.keyboard("{Enter}");
      await tick();
    };
    await choose(
      screen.getAllByTestId("policy-preset")[0],
      "policy-preset-custom",
    );
    expect(screen.getByTestId("where").textContent).toBe(
      "/config?tab=permissions&custom=careful",
    );
    for (const area of POLICY_AREAS) {
      await choose(
        screen.getAllByTestId(`policy-select-${area}`)[0],
        `policy-option-${area}-custom`,
      );
      expect(screen.getByTestId("where").textContent).toBe(
        `/config?tab=permissions&custom=careful&area=${area}`,
      );
    }
  });
});

interface Calls {
  save: ReturnType<typeof vi.fn>;
  edits: { type: string; data: any }[];
}

async function openEditor(entry: string, over: { saveFails?: string } = {}) {
  const ideMessenger = new MockIdeMessenger();
  const edits: Calls["edits"] = [];
  const save = vi.fn(async (_update: unknown) => {
    if (over.saveFails) throw new Error(over.saveFails);
    return undefined;
  });
  ideMessenger.responseHandlers["policy/rules"] = (async () => report) as any;
  ideMessenger.responseHandlers["policy/save"] = save as any;
  ideMessenger.responseHandlers["audit/overview"] = (async () => ({
    state: "ready",
    coverageDays: 30,
    partial: false,
    rules: {},
    mostAsked: [
      {
        rule: "runTerminalCommand(ls*)",
        answer: "allow",
        asks: 5,
        answered: 5,
        last: "2026-11-12",
      },
    ],
  })) as any;
  ideMessenger.responseHandlers["audit/list"] = (async () => ({
    rows: [
      {
        session: "s",
        callId: "1",
        tool: "run_terminal_command",
        ts: "2026-11-13T00:00:00Z",
        policy: "ask",
        by: "person",
        asked: true,
        summary: "git push origin main",
      },
      {
        session: "s",
        callId: "2",
        tool: "run_terminal_command",
        ts: "2026-11-13T00:00:01Z",
        policy: "allow",
        by: "rules",
        asked: false,
        summary: "git status",
      },
    ],
    facets: { tools: [], agents: [] },
  })) as any;
  for (const type of [
    "config/addToolRule",
    "config/updateToolRule",
    "config/removeToolRule",
  ] as const) {
    ideMessenger.responseHandlers[type] = (async (data: any) => {
      edits.push({ type, data });
      const done = {
        "config/addToolRule": "added",
        "config/updateToolRule": "updated",
        "config/removeToolRule": "removed",
      }[type];
      return {
        result: data.dryRun ? "preview" : done,
        analysis: {
          valid: true,
          rule: data.rule,
          broad: false,
          friction:
            data.decision === "deny" && type === "config/removeToolRule"
              ? "confirm"
              : "none",
          loosens: false,
          warnings: [],
        },
        afterHash: `after-${edits.length}`,
      };
    }) as any;
  }
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
    routerProps: { initialEntries: [entry] } as any,
  });
  await act(async () => {});
  return { ...view, store, save, edits };
}

const step = async (n: number) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`custom-step-${n}`));
  });
};

describe("the Custom policy editor", () => {
  it("is prefilled from the chosen base: the preset's five levels", async () => {
    await openEditor("/config?tab=permissions&custom=handsOff");
    expect(screen.getByTestId("custom-policy-base").textContent).toContain(
      "Hands off",
    );
    expect(
      (screen.getByTestId("custom-base-handsOff") as HTMLInputElement).checked,
    ).toBe(true);
    await step(1);
    for (const area of POLICY_AREAS) {
      expect(
        (screen.getByTestId(`custom-level-${area}`) as HTMLSelectElement).value,
      ).toBe(POLICY_PRESETS.handsOff.levels[area]);
    }
    expect(screen.getByTestId("custom-matches").textContent).toContain(
      "Hands off",
    );
    // Choosing another base refills the levels
    await step(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-base-idgaf"));
    });
    expect(screen.getByTestId("custom-idgaf-note")).toBeDefined();
    await step(1);
    expect(
      (screen.getByTestId("custom-level-edits") as HTMLSelectElement).value,
    ).toBe("idgaf");
  });

  it("opened from an area, it starts at the levels with that area focused", async () => {
    await openEditor("/config?tab=permissions&custom=careful&area=edits");
    expect(screen.getByTestId("custom-step-heading").textContent).toBe(
      "Levels and settings",
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("custom-level-edits"),
    );
  });

  it("add, move and remove are saved as the rule editor's own checked edits, in order", async () => {
    const { save, edits } = await openEditor(
      "/config?tab=permissions&custom=current",
    );
    await step(2);
    const editor = screen.getByTestId("rule-lists-editor");
    // The lists are the person's own; the workspace's Always rule is not one of them
    expect(
      within(screen.getByTestId("list-allow")).queryByText(/curl/),
    ).toBeNull();
    // Add, with the live preview against recent calls
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push*)x" },
    });
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(rm -rf /*)" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "Matches 0 of the last 2 calls.",
    );
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git *)" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "Matches 2 of the last 2 calls.",
    );
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(rm -rf /*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    expect(
      within(screen.getByTestId("list-deny")).getByText(
        "runTerminalCommand(rm -rf /*)",
      ),
    ).toBeDefined();
    // Move Ask -> Never, remove the Always
    await act(async () => {
      fireEvent.change(
        screen.getByTestId("move-ask-runTerminalCommand(git push*)"),
        { target: { value: "deny" } },
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("remove-allow-runTerminalCommand(npm test*)"),
      );
    });
    expect(screen.getByTestId("list-allow").textContent).not.toContain(
      "npm test",
    );
    expect(editor).toBeDefined();

    await step(4);
    await act(async () => {});
    expect(screen.getByTestId("custom-rule-changes").textContent).toBe(
      [
        "Remove from Always: runTerminalCommand(npm test*)",
        "Move from Ask to Never: runTerminalCommand(git push*)",
        "Add to Never: runTerminalCommand(rm -rf /*)",
      ].join(""),
    );
    // Dry runs only so far
    expect(edits.every((e) => e.data.dryRun)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    expect(save).toHaveBeenCalledTimes(1);
    const written = edits.filter((e) => !e.data.dryRun);
    expect(written.map((e) => [e.type, e.data.rule, e.data.baseHash])).toEqual([
      ["config/removeToolRule", "runTerminalCommand(npm test*)", "h1"],
      ["config/updateToolRule", "runTerminalCommand(git push*)", "after-4"],
      ["config/addToolRule", "runTerminalCommand(rm -rf /*)", "after-5"],
    ]);
    expect(written[1].data.newDecision).toBe("deny");
    // Nothing a workspace wrote reached the writer
    expect(JSON.stringify(written)).not.toContain("curl");
    expect(JSON.stringify(save.mock.calls)).not.toContain("curl");
    // Closed, and the page says what was saved
    expect(screen.queryByTestId("custom-policy")).toBeNull();
    expect(screen.getByTestId("change-status").textContent).toContain(
      "3 rule changes",
    );
  });

  it("an invalid pattern is refused with a message and nothing is added", async () => {
    await openEditor("/config?tab=permissions&custom=current");
    await step(2);
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand()" },
    });
    expect(screen.getByTestId("add-rule-preview").textContent).toContain(
      "cannot be read as a rule yet",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    const error = screen.getByTestId("add-rule-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "Write a rule as toolName(pattern), or just toolName. A pattern in brackets cannot be empty.",
    );
    expect(
      screen.getByTestId("add-rule-input").getAttribute("aria-invalid"),
    ).toBe("true");
    // A rule already in another list says where it is
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    expect(screen.getByTestId("add-rule-error").textContent).toBe(
      "That rule is already in the Ask list. Move it instead.",
    );
    await step(4);
    expect(screen.getByTestId("custom-nothing")).toBeDefined();
    expect(
      (screen.getByTestId("custom-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("settings in permissions.yaml: the floor, trust and Plan's MCP tools are saved in one write", async () => {
    const { save } = await openEditor("/config?tab=permissions&custom=current");
    await step(2);
    await act(async () => {
      fireEvent.change(screen.getByTestId("add-rule-list"), {
        target: { value: "floor" },
      });
    });
    fireEvent.change(screen.getByTestId("add-rule-input"), {
      target: { value: "runTerminalCommand(git push --force*)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-rule-submit"));
    });
    await step(3);
    fireEvent.change(screen.getByTestId("plan-mcp-tools-input"), {
      target: { value: "a/b/c" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("plan-mcp-tools-input"));
    });
    expect(screen.getByTestId("plan-mcp-tools").textContent).toContain(
      "Write server/tool, server/* or server.",
    );
    fireEvent.change(screen.getByTestId("plan-mcp-tools-input"), {
      target: { value: "github/get_issue" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("plan-mcp-tools-input"));
    });
    fireEvent.change(screen.getByTestId("trusted-servers-input"), {
      target: { value: "docs" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("trusted-servers-input"));
    });
    await step(4);
    await act(async () => {});
    const changes = screen.getByTestId("custom-setting-changes").textContent;
    expect(changes).toContain("floor");
    expect(changes).toContain("plan.mcpTools");
    // Trusting a server loosens: Save waits for the acknowledgement
    const saveButton = screen.getByTestId("custom-save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-ack"));
    });
    expect(saveButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      floor: ["runTerminalCommand(git push --force*)"],
      planMcpTools: ["github/get_issue"],
      trustedMcpServers: ["docs"],
      planAllowTerminal: false,
      levels: DEFAULT_POLICY_LEVELS,
    });
  });

  it("a failed write says nothing was saved and leaves the editor open", async () => {
    const { edits } = await openEditor(
      "/config?tab=permissions&custom=current",
      {
        saveFails: "permissions.yaml is locked",
      },
    );
    await step(1);
    await act(async () => {
      // Tighter, so no acknowledgement is asked for
      fireEvent.change(screen.getByTestId("custom-level-tools"), {
        target: { value: "manual" },
      });
    });
    await step(4);
    await act(async () => {
      fireEvent.click(screen.getByTestId("custom-save"));
    });
    expect(screen.getByTestId("custom-save-error").textContent).toContain(
      "Nothing was saved",
    );
    expect(screen.getByTestId("custom-policy")).toBeDefined();
    expect(edits.filter((e) => !e.data.dryRun)).toEqual([]);
  });
});
