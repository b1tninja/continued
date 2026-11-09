import type { Tool } from "../..";
import { areaOfTool, PolicyArea, PolicyLevel, PolicyLevels } from "./policy";

/**
 * What the person has chosen for each area (plans/policy-areas.md). Core never
 * guesses a level: a caller that sends nothing gets Cautious everywhere, which
 * is the behaviour from before levels existed (rules and the tool's own setting).
 *
 * Per area, for tool calls:
 * - manual: asks every time. Allow rules and the tool's own setting are not
 *   consulted; deny and ask rules and every protection still apply.
 * - cautious: the rules and the tool's own setting decide.
 * - automatic: as cautious here. What the rules leave open goes to the reviewer
 *   model, which the caller asks (core's `tools/autoReview`).
 * - permissive: a call the rules left open runs. A deny rule, an ask rule, a
 *   protected path and the safety floor still win.
 * - yolo: every call runs, whatever a rule, a protected path or the safety
 *   floor says. Only a tool switched off stays off.
 */
export interface ApprovalSettings {
  levels: PolicyLevels;
}

/** What a level decided, for the decision chip. */
export interface Loosening {
  source: "permissive" | "yolo";
  reason: string;
  /** Allows the call whatever else applies (YOLO). */
  absolute?: boolean;
}

type ToolLike = Pick<
  Tool,
  | "group"
  | "originalFunctionName"
  | "uri"
  | "evaluateToolCallPolicy"
  | "readonly"
>;

export interface LevelOfCall {
  area: "context" | "tools" | "edits";
  level: PolicyLevel;
}

/**
 * The area a call belongs to and the level set for it. Undefined when the
 * caller sent no levels or the tool only touches the session (the task list,
 * Loop's tools), which no level governs.
 */
export function levelOfCall(
  approval: ApprovalSettings | undefined,
  toolName: string,
  tool: Pick<Tool, "readonly"> | undefined,
): LevelOfCall | undefined {
  if (!approval) return undefined;
  const area = areaOfTool(toolName, tool);
  if (!area) return undefined;
  const level = approval.levels[area as PolicyArea];
  return level ? { area, level } : undefined;
}

/**
 * Would the tool's own check pass if the user had set it to run without
 * asking? That is false for a file outside the workspace and for a command the
 * safety floor does not call safe, so Permissive never reaches past them for
 * reads.
 */
function passesOwnCheck(
  tool: ToolLike | undefined,
  parsedArgs: Record<string, unknown>,
  processedArgs: Record<string, unknown> | undefined,
): boolean {
  if (!tool?.evaluateToolCallPolicy) return true;
  return (
    tool.evaluateToolCallPolicy(
      "allowedWithoutPermission",
      parsedArgs,
      processedArgs,
    ) === "allowedWithoutPermission"
  );
}

export interface LooseningInput {
  approval: ApprovalSettings | undefined;
  tool: ToolLike | undefined;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
}

/**
 * Whether the level for this call's area allows it without asking. The caller
 * applies the result only to a call that is still open (no rule matched, not
 * protected, not refused), except for YOLO, which is absolute.
 */
export function approvalLoosening(
  input: LooseningInput,
): Loosening | undefined {
  const { approval, tool, toolName, parsedArgs, processedArgs } = input;
  const found = levelOfCall(approval, toolName, tool);
  if (!found) return undefined;

  if (found.level === "yolo") {
    return {
      source: "yolo",
      reason: `Allowed: ${found.area === "context" ? "Context use" : found.area === "edits" ? "File edits" : "Tool use"} is set to YOLO.`,
      absolute: true,
    };
  }
  if (found.level === "permissive") {
    // A read outside the workspace still asks: Permissive is "no rule stops
    // it", and the tool's own workspace check is a protection, not a rule.
    if (
      found.area === "context" &&
      !passesOwnCheck(tool, parsedArgs, processedArgs)
    ) {
      return undefined;
    }
    return {
      source: "permissive",
      reason: `Allowed: ${found.area === "context" ? "Context use" : found.area === "edits" ? "File edits" : "Tool use"} is Permissive and no rule stops it.`,
    };
  }
  return undefined;
}

/**
 * Manual: ask every time, whatever the tool's own setting or an allow rule
 * says. File edits are excluded because their check is the diff the person
 * accepts or rejects, which is the same at every level below Permissive.
 */
export function isManualCall(
  approval: ApprovalSettings | undefined,
  toolName: string,
  tool: Pick<Tool, "readonly"> | undefined,
): boolean {
  const found = levelOfCall(approval, toolName, tool);
  return found?.level === "manual" && found.area !== "edits";
}
