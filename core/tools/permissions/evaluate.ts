import type { ToolPolicy } from "@continuedev/terminal-security";
import type { Tool } from "../..";
import type { ResolvedPath } from "../../util/pathResolver";
import {
  approvalLoosening,
  ApprovalSettings,
  isManualCall,
  levelOfCall,
  skippedProtections,
} from "./approval";
import { hiddenCommandName } from "./commandName";
import { hasUnsafeShellConstruct } from "./command";
import { DecisionSource, decideToolCall, findRuleMatch } from "./decide";
import type { ShellKind } from "../../util/shell";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import { builtinRuleOn } from "./policy";
import { parsePermissions, uriToPath } from "./names";
import { findProtected } from "./protectedCall";
import { policyFileHit, POLICY_FILE_REASON } from "./selfProtect";
import type { ProtectedHit, ProtectedKind } from "./protected";
import type { RuleSource, ToolPermissions } from "./rules";

/**
 * Brace expansion or `$IFS`: the safety floor never sees the command that will
 * actually run, so the text is refused when that floor is on. PowerShell and
 * cmd have neither (`{ $_.a, $_.b }` is a script block there, `$IFS` an
 * ordinary variable), so they are not refused for it.
 *
 * A variable where the command name is does not refuse: it asks, at every
 * level (hiddenCommandName).
 */
export function floorMustRefuse(
  command: string | undefined,
  shell?: ShellKind,
): boolean {
  if (command === undefined) return false;
  if (shell === "powershell" || shell === "cmd") return false;
  if (unquotedBraceWithComma(command)) return true;
  return /\$\{?IFS\b/.test(command);
}

/** A level must not run a command the floor could not see through. */
function hidesTheCommand(
  command: string | undefined,
  shell?: ShellKind,
): boolean {
  if (command === undefined) return false;
  return (
    floorMustRefuse(command, shell) ||
    hasUnsafeShellConstruct(command) ||
    hiddenCommandName(command, shell) !== undefined
  );
}

function unquotedBraceWithComma(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let body = "";
  let open = false;
  const flush = () => {
    open = false;
    body = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      flush();
      continue;
    }
    if (c === "\\") {
      i++;
      flush();
      continue;
    }
    if (c === "{") {
      open = true;
      body = "";
      continue;
    }
    if (c === "}" && open) {
      if (body.includes(",")) return true;
      flush();
      continue;
    }
    if (open) body += c;
  }
  return false;
}

export interface ToolPolicyResult {
  policy: ToolPolicy;
  displayValue?: string;
  /** Present only when the user has rules, so existing callers see no change. */
  source?: DecisionSource;
  /** A sentence a person can read, for the prompt or the refusal. */
  reason?: string;
  /** What kind of protected call asked (source "protected-path") */
  protection?: ProtectedKind;
  /** A command the parser vouched as only reading: why it is Context use */
  readOnly?: string;
  /** The rule that decided, as written in config.yaml. */
  rule?: string;
}

export interface EvaluateInput {
  tool:
    | Pick<
        Tool,
        | "group"
        | "originalFunctionName"
        | "uri"
        | "evaluateToolCallPolicy"
        | "readonly"
        | "mcpDefinitionChange"
      >
    | undefined;
  toolName: string;
  basePolicy: ToolPolicy;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  permissions: ToolPermissions | undefined;
  /**
   * The same rules by where each was written. When given, these are the rules
   * that run (`permissions` still carries the reviewer's settings) and each
   * reason names the file its rule came from.
   */
  permissionSources?: Partial<Record<RuleSource, ToolPermissions>>;
  /** The folder a command runs in; lets git be vouched read-only */
  cwd?: string;
  /** The shell that runs it (resolveShell); without one no command is vouched read-only */
  shell?: ShellKind;
  /** The level chosen for each area; absent means Cautious everywhere. */
  approval?: ApprovalSettings;
}

/**
 * The policy for one tool call: the tool's own check first (command safety
 * floor, workspace-only reads), then the user's `toolPermissions` rules on top.
 * Without rules this returns exactly what it did before rules existed.
 */
export function evaluateToolPolicyWithRules(
  input: EvaluateInput,
): ToolPolicyResult {
  return lockPolicyFiles(input, evaluateRules(input));
}

/**
 * The locked floor (selfProtect.ts): a call that would write or delete a
 * permission or policy file asks, and is refused at Automatic and YOLO, where
 * nobody is there to say yes to a change that undoes the other protections.
 * It runs after everything else and only tightens, so no rule, level or
 * built-in switch can loosen it.
 */
function lockPolicyFiles(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { tool, toolName } = input;
  if (!tool || result.policy === "disabled") return result;
  const resolved = input.processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const isMcp = !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;
  const hit = policyFileHit({
    toolName,
    parsedArgs: input.parsedArgs,
    resolvedPath: resolved ? uriToPath(resolved.uri) : undefined,
    mcp: isMcp ? { readonly: !!tool.readonly } : undefined,
    cwd: input.cwd,
    shell: input.shell,
  });
  if (!hit) return result;
  const level = levelOfCall(input.approval, toolName, tool, {
    parsedArgs: input.parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  })?.level;
  // A scan that gave up cannot say the call is a write: it asks, never refuses.
  const refuse = (level === "automatic" || level === "yolo") && !hit.capped;
  if (!refuse && result.policy === "allowedWithPermission") return result;
  return {
    ...result,
    policy: refuse ? "disabled" : "allowedWithPermission",
    source: "floor",
    reason: `${POLICY_FILE_REASON} (${hit.path})`,
  };
}

function evaluateRules(input: EvaluateInput): ToolPolicyResult {
  const { tool, toolName, basePolicy, parsedArgs, processedArgs } = input;

  // A tool we do not know has nothing to check, as before.
  if (!tool) return { policy: basePolicy };

  // The command, so a refusal can show what was refused. (This used to compare
  // against "runTerminalCommand", which is never the tool's real name, so the
  // command was never shown.)
  let displayValue: string | undefined;
  if (toolName === "run_terminal_command" && parsedArgs.command) {
    displayValue = parsedArgs.command as string;
  }

  let evaluated = tool.evaluateToolCallPolicy
    ? tool.evaluateToolCallPolicy(basePolicy, parsedArgs, processedArgs)
    : basePolicy;
  const commandText =
    toolName === "run_terminal_command" &&
    typeof parsedArgs.command === "string"
      ? parsedArgs.command
      : undefined;
  const floorOn = builtinRuleOn(input.approval, "refuse-dangerous-commands");
  // The person switched off the safety check's refusals: such a command asks
  if (
    evaluated === "disabled" &&
    basePolicy !== "disabled" &&
    commandText !== undefined &&
    !floorOn
  ) {
    evaluated = "allowedWithPermission";
  }
  // Obfuscation the floor cannot see through is the same as a refusal: a level
  // must not turn it into a run.
  if (
    floorOn &&
    basePolicy !== "disabled" &&
    evaluated !== "disabled" &&
    floorMustRefuse(commandText, input.shell)
  ) {
    evaluated = "disabled";
  }

  const resolved = processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const resolvedPath = resolved ? uriToPath(resolved.uri) : undefined;

  // Credentials and files that change what runs later always ask, with or
  // without rules, so this runs for every user and not only those with rules.
  // It only ever tightens: a call that is already refused stays refused.
  // A private or local URL always asks. Permissive (Hands-off) and an allow
  // rule can loosen the tool's own "ask", so this is a protection, like a
  // protected path. YOLO still reaches past it.
  const privateUrl =
    toolName === "fetch_url_content" &&
    isPrivateFetchTarget(parsedArgs.url, processedArgs)
      ? ({
          kind: "private-url",
          path: fetchHost(parsedArgs.url),
        } satisfies ProtectedHit)
      : undefined;
  // A tool whose MCP definition changed since approval asks again. Never in
  // the skip list: no setting turns it off, and YOLO alone reaches past it.
  const changedDefinition = changedDefinitionHit(
    tool.mcpDefinitionChange,
    basePolicy,
  );
  const hiddenName = floorOn
    ? hiddenNameHit(commandText, input.shell)
    : undefined;
  const protectedHit =
    findProtected({
      toolName,
      parsedArgs,
      resolvedPath,
      skip: skippedProtections(input.approval),
      cwd: input.cwd,
      shell: input.shell,
    }) ??
    privateUrl ??
    changedDefinition ??
    hiddenName;

  // The floor: deny rules the person wrote to bind even at YOLO
  const floorRules = parsePermissions({ deny: input.approval?.floor }, "floor");
  if (floorRules.length) {
    const isMcpCall =
      !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;
    const floorMatch = findRuleMatch({
      toolName,
      mcp: isMcpCall
        ? { serverName: tool.group, toolName: tool.originalFunctionName! }
        : undefined,
      parsedArgs,
      resolvedPath,
      base: basePolicy,
      evaluated,
      rules: floorRules,
      shell: input.shell,
    });
    if (floorMatch?.decision === "deny") {
      return {
        policy: "disabled",
        displayValue,
        source: "floor",
        rule: floorMatch.rule.raw,
        reason: `Blocked by your floor rule ${floorMatch.rule.raw}, which binds at every level.`,
      };
    }
  }

  const rules = input.permissionSources
    ? Object.entries(input.permissionSources).flatMap(([origin, perms]) =>
        parsePermissions(perms, origin as RuleSource),
      )
    : parsePermissions(input.permissions);
  const call = { parsedArgs, cwd: input.cwd, shell: input.shell };
  const found = levelOfCall(input.approval, toolName, tool, call);
  // A hidden command is not loosened at any level, YOLO included. Otherwise
  // YOLO reaches past a refusal, a rule and a protected path, and Permissive
  // acts only on a call that would otherwise ask.
  const hidden = floorOn && hidesTheCommand(commandText, input.shell);
  const loosening = hidden
    ? undefined
    : found?.level === "yolo" || evaluated === "allowedWithPermission"
      ? approvalLoosening({
          approval: input.approval,
          tool,
          toolName,
          parsedArgs,
          processedArgs,
          cwd: input.cwd,
          shell: input.shell,
        })
      : undefined;
  const manual =
    isManualCall(input.approval, toolName, tool, call) &&
    basePolicy !== "disabled" &&
    !loosening;
  if (rules.length === 0 && !protectedHit && !loosening && !manual) {
    return {
      policy: evaluated,
      displayValue,
      ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
    };
  }

  const isMcp = !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;

  const decision = decideToolCall({
    toolName,
    mcp: isMcp
      ? { serverName: tool.group, toolName: tool.originalFunctionName! }
      : undefined,
    parsedArgs,
    resolvedPath,
    base: basePolicy,
    evaluated,
    rules,
    protectedHit,
    loosening,
    manual,
    shell: input.shell,
  });

  return {
    policy: decision.policy,
    displayValue,
    source: decision.source,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.protection ? { protection: decision.protection } : {}),
    ...(decision.rule ? { rule: decision.rule } : {}),
    ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
  };
}

/** A command whose program is a variable asks, whatever else is said about it. */
function hiddenNameHit(
  command: string | undefined,
  shell: ShellKind | undefined,
): ProtectedHit | undefined {
  const why =
    command === undefined ? undefined : hiddenCommandName(command, shell);
  return why ? { kind: "hidden-command", path: why } : undefined;
}

function changedDefinitionHit(
  change: { kind: "changed" | "added" | "launch"; summary: string } | undefined,
  basePolicy: ToolPolicy,
): ProtectedHit | undefined {
  if (!change || basePolicy === "disabled") return undefined;
  return {
    kind: "mcp-definition-changed",
    path:
      change.kind === "launch"
        ? change.summary
        : `${change.kind === "added" ? "new tool" : "changed"}, ${change.summary}`,
  };
}

function fetchHost(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw;
  }
}
