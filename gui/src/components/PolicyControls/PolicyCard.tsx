import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
} from "core/tools/permissions/policy";
import { Card } from "../ui";
import { AreaLevelSelect, PresetSelect } from "./PolicyControls";

const AREA_HINTS = {
  context: "Reading files and searching. What the agent looks at.",
  tools: "Commands, MCP tools and the web. What the agent runs.",
  edits:
    "Changing files. At Permissive and YOLO an edit is kept without a diff review.",
  plan: "Loop only. Whether a plan or re-plan goes on without you.",
  questions: "Loop only. Whether the agent answers its own questions.",
} as const;

/**
 * Settings > Tools: the same five controls as the toolbar, with their
 * explanations. Deny rules, ask rules and protected paths always win, except
 * for an area set to YOLO.
 */
export function PolicyCard() {
  return (
    <div data-testid="policy-card">
      <h3 className="my-0 mb-1 text-sm font-semibold">Approval</h3>
      <p className="mt-0 mb-2 text-xs text-description">
        One decision per area: who decides a call your rules leave open. Fewer
        decisions reach you as you go from Manual to YOLO.
      </p>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-sm">Preset</span>
              <span className="text-2xs text-description-muted">
                Sets all five areas at once.
              </span>
            </div>
            <PresetSelect />
          </div>
          {POLICY_AREAS.map((area) => (
            <div
              key={area}
              data-testid={`policy-row-${area}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex flex-col">
                <span className="text-sm">{POLICY_AREA_LABELS[area]}</span>
                <span className="text-2xs text-description-muted">
                  {AREA_HINTS[area]}
                </span>
              </div>
              <AreaLevelSelect area={area} variant="row" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
