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
import { envAssignmentHit } from "./envAssignments";
import { maskAssignmentValues } from "./envMask";
import type { EnvNameOptions } from "./envNames";
import { DecisionSource, decideToolCall, findRuleMatch } from "./decide";
import type { ShellKind } from "../../util/shell";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import { askProtectionHit } from "./askProtections";
import { deputyCallHit, type DeputyCallInput } from "./deputyCall";
import { outsideTargetReason } from "./outsideEdits";
import { builtinRuleOn } from "./policy";
import { parsePermissions, uriToPath } from "./names";
import { findProtected } from "./protectedCall";
import type { Sink } from "./taint/taintSinks";
import {
  applyTaintedSessionRule,
  type TaintedSessionInput,
} from "./taint/taintRule";
import { runtimeWriteTarget } from "./runtimeWriteTarget";
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
  envNames?: EnvNameOptions,
): boolean {
  if (command === undefined) return false;
  return (
    floorMustRefuse(command, shell) ||
    hasUnsafeShellConstruct(command, shell) ||
    hiddenCommandName(command, shell) !== undefined ||
    envAssignmentHit(command, shell, envNames)?.severity === "dangerous"
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
  /** Set only in a tainted session: the sink class the call is (taint/taintSinks.ts) */
  taintSink?: Sink;
}

export interface EvaluateInput extends TaintedSessionInput {
  tool:
    | (Pick<
        Tool,
        | "group"
        | "originalFunctionName"
        | "uri"
        | "evaluateToolCallPolicy"
        | "readonly"
        | "mcpDefinitionChange"
      > & { function?: Pick<Tool["function"], "parameters"> })
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
  /** Every workspace folder as a path (the first is `cwd`); a path in any is inside */
  workspaceDirs?: readonly string[];
  /** Follows links for an MCP path argument; set only for a local workspace (realPath.ts) */
  resolvePath?: DeputyCallInput["resolvePath"];
  /** The shell that runs it (resolveShell); without one no command is vouched read-only */
  shell?: ShellKind;
  /** The level chosen for each area; absent means Cautious everywhere. */
  approval?: ApprovalSettings;
  /**
   * Domains the person trusts, read from their own config file and nothing
   * else (never a workspace file or an assistant). `ask-unknown-host` acts
   * only when this is non-empty.
   */
  trustedDomains?: readonly string[];
  /** The person's own `largeChangeLines` (default 300); `ask-large-change` asks above it */
  largeChangeLines?: number;
  /**
   * Environment variable names the person added to or took off the lists of
   * names that change what a command does (envNames.ts), from their own
   * config file and nothing else.
   */
  envNames?: EnvNameOptions;
  /** Path syntax to judge file paths by; the host's when absent. Tests set it. */
  platform?: "win32" | "posix";
  /** The home folder; the host's when absent. Tests set it. */
  home?: string;
}

/**
 * The policy for one tool call: the tool's own check first (command safety
 * floor, workspace-only reads), then the user's `toolPermissions` rules on top.
 * Without rules this returns exactly what it did before rules existed.
 */
export function evaluateToolPolicyWithRules(
  input: EvaluateInput,
): ToolPolicyResult {
  return applyTaintedSessionRule(
    input,
    lockRuntimeWrites(input, lockPolicyFiles(input, evaluateRules(input))),
  );
}

/**
 * ROADMAP B31. The path guards read a path as it is written, so a terminal
 * command whose write target is built when it runs (`$d`, a wildcard, a
 * backtick, a bare name after a `cd` into the home folder) is not covered by
 * them. At IDGAF, which would otherwise run it, it asks. It only tightens: a
 * call already refused or already asked is left as it is, and no rule or
 * setting loosens it. The sandbox that denies writes to the policy folders (W8)
 * is what holds for certain.
 */
export const RUNTIME_WRITE_REASON =
  "This command writes to a path built when it runs, which the path guards cannot read, so at IDGAF it asks.";

function lockRuntimeWrites(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { tool, toolName, parsedArgs } = input;
  const command = parsedArgs.command;
  if (!tool || toolName !== "run_terminal_command") return result;
  if (
    typeof command !== "string" ||
    result.policy !== "allowedWithoutPermission"
  ) {
    return result;
  }
  const level = levelOfCall(input.approval, toolName, tool, {
    parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  })?.level;
  if (level !== "idgaf") return result;
  const why = runtimeWriteTarget(command, input.shell, input.cwd);
  if (!why) return result;
  return {
    ...result,
    policy: "allowedWithPermission",
    source: "floor",
    reason: `${RUNTIME_WRITE_REASON} (${why})`,
  };
}

/**
 * The locked floor (selfProtect.ts): a call that would write or delete a
 * permission or policy file asks, and is refused at Automatic and IDGAF, where
 * nobody is there to say yes to a change that undoes the other protections.
 * That holds for a path the call names. A terminal command is read as it is
 * written, so a path built when it runs is not seen here; at IDGAF such a
 * command asks instead (lockRuntimeWrites).
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
  const refuse = (level === "automatic" || level === "idgaf") && !hit.capped;
  if (!refuse && result.policy === "allowedWithPermission") return result;
  return {
    ...result,
    policy: refuse ? "disabled" : "allowedWithPermission",
    source: "floor",
    reason: `${POLICY_FILE_REASON} (${hit.path})`,
  };
}

interface ProtectedHitParts {
  resolved: ResolvedPath | null | undefined;
  resolvedPath: string | undefined;
  privateUrl: ProtectedHit | undefined;
  changedDefinition: ProtectedHit | undefined;
  hiddenName: ProtectedHit | undefined;
  envHit: ProtectedHit | undefined;
}

/**
 * The first protection that applies, in the order the checks run. Kept apart
 * from evaluateRules so each new protection does not push that function over
 * the complexity limit.
 */
function firstProtectedHit(
  input: EvaluateInput,
  parts: ProtectedHitParts,
): ProtectedHit | undefined {
  const { tool, toolName, parsedArgs } = input;
  const { resolved, resolvedPath } = parts;
  return [
    findProtected({
      toolName,
      parsedArgs,
      resolvedPath,
      skip: skippedProtections(input.approval),
      cwd: input.cwd,
      shell: input.shell,
    }),
    parts.privateUrl,
    parts.changedDefinition,
    parts.hiddenName,
    parts.envHit,
    askProtectionHit({
      toolName,
      parsedArgs,
      resolvedPath,
      shell: input.shell,
      approval: input.approval,
      trustedDomains: input.trustedDomains,
      largeChangeLines: input.largeChangeLines,
      cwd: input.cwd,
    }),
    deputyCallHit(deputyInputOf(input, resolved, resolvedPath)),
  ].find((hit) => hit !== undefined);
}

function deputyInputOf(
  input: EvaluateInput,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): DeputyCallInput {
  const { tool, toolName, parsedArgs } = input;
  return {
    toolName,
    parsedArgs,
    resolved: resolved
      ? {
          path: resolvedPath,
          withinWorkspace: resolved.isWithinWorkspace,
        }
      : undefined,
    cwd: input.cwd,
    workspaceDirs: input.workspaceDirs,
    resolvePath: input.resolvePath,
    schema: tool?.function?.parameters,
    approval: input.approval,
    flavor: input.platform,
    home: input.home,
    mcp: !!tool?.uri?.startsWith("mcp:") && !!tool?.originalFunctionName,
  };
}

/** The decision's reason; at IDGAF on File edits it also names a target outside the workspace. */
function reasonWithOutsideTarget(
  input: EvaluateInput,
  decision: { source?: DecisionSource; policy: ToolPolicy; reason?: string },
  area: string | undefined,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): string | undefined {
  if (
    decision.source !== "yolo" ||
    decision.policy !== "allowedWithoutPermission" ||
    area !== "edits"
  ) {
    return decision.reason;
  }
  const note = outsideTargetNote(input, resolved, resolvedPath);
  return note ? `${decision.reason ?? ""} ${note}`.trim() : decision.reason;
}

/**
 * The absolute path a File edits call reaches outside the workspace, when
 * IDGAF lets it through: said in the decision, so the audit trail and the
 * transcript name the place. The built-in rule is not consulted for the
 * judgement (it may be switched off, and the fact stays true).
 */
function outsideTargetNote(
  input: EvaluateInput,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): string | undefined {
  const hit = deputyCallHit({
    ...deputyInputOf(input, resolved, resolvedPath),
    approval: undefined,
  });
  const suffix = ", outside the workspace";
  if (!hit?.path.endsWith(suffix)) return undefined;
  return outsideTargetReason(hit.path.slice(0, -suffix.length));
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
    // A secret in an assignment (`API_KEY=sk-... curl`) is not shown
    displayValue = maskAssignmentValues(parsedArgs.command as string);
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
  // protected path. IDGAF still reaches past it.
  const privateUrl =
    toolName === "fetch_url_content" &&
    isPrivateFetchTarget(parsedArgs.url, processedArgs)
      ? ({
          kind: "private-url",
          path: fetchHost(parsedArgs.url),
        } satisfies ProtectedHit)
      : undefined;
  // A tool whose MCP definition changed since approval asks again. Never in
  // the skip list: no setting turns it off, and IDGAF alone reaches past it.
  const changedDefinition = changedDefinitionHit(
    tool.mcpDefinitionChange,
    basePolicy,
  );
  const hiddenName = floorOn
    ? hiddenNameHit(commandText, input.shell)
    : undefined;
  const envHit = floorOn
    ? envAssignmentProtection(commandText, input.shell, input.envNames)
    : undefined;
  const protectedHit = firstProtectedHit(input, {
    resolved,
    resolvedPath,
    privateUrl,
    changedDefinition,
    hiddenName,
    envHit,
  });

  // The floor: deny rules the person wrote to bind even at IDGAF
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
  // A hidden command is not loosened at any level, IDGAF included. Otherwise
  // IDGAF reaches past a refusal, a rule and a protected path, and Permissive
  // acts only on a call that would otherwise ask.
  const hidden =
    floorOn && hidesTheCommand(commandText, input.shell, input.envNames);
  const loosening = hidden
    ? undefined
    : found?.level === "idgaf" || evaluated === "allowedWithPermission"
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

  const reason = reasonWithOutsideTarget(
    input,
    decision,
    found?.area,
    resolved,
    resolvedPath,
  );

  return {
    policy: decision.policy,
    displayValue,
    source: decision.source,
    ...(reason ? { reason } : {}),
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

/** A variable set in front of the command that changes what it does: the name, never the value. */
function envAssignmentProtection(
  command: string | undefined,
  shell: ShellKind | undefined,
  names: EnvNameOptions | undefined,
): ProtectedHit | undefined {
  const hit =
    command === undefined ? undefined : envAssignmentHit(command, shell, names);
  return hit ? { kind: "env-assignment", path: hit.reason } : undefined;
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
