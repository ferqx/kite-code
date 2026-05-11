import { createHash } from "node:crypto";
import type {
  AgentPhase,
  AuthorizationMode,
  ShellApprovalGrant,
  ShellGrantUsed,
  WorkspaceAccess,
} from "../../protocol/events";
import type {
  AuthorizationOverride,
  ThreadAuthorizationState,
} from "../types";
import { isReadOnlyShellCommand } from "../tools/definitions";
import type { PendingToolRequest } from "./tool-requests";

export type ToolRisk =
  | "read"
  | "plan"
  | "write_file"
  | "execute_code"
  | "destructive"
  | "network"
  | "vcs_mutation"
  | "unknown";

export interface ToolPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  risk: ToolRisk;
  reason: string;
  userVisibleSummary: string;
  expectedEffects: string[];
  grantUsed: ShellGrantUsed;
}

export interface ToolApprovalPayload {
  scope: "once";
  cwd: string;
  threadId: string;
  tool: PendingToolRequest["name"];
  command: string;
  risk: ToolRisk;
  approvalHash: string;
  summary: string;
  reason: string;
  expectedEffects: string[];
  modelJustification?: string;
  objective?: string;
  expectedObservation?: string;
  failureStrategy?: string;
  suggestedPrefixRule?: string[];
  grantOptions: ShellApprovalGrant[];
  recommendedGrant: ShellApprovalGrant;
}

/** 创建默认 thread 授权状态 / Create default thread authorization state */
export function defaultAuthorizationState(): ThreadAuthorizationState {
  return {
    mode: "default",
    commandGrants: {},
  };
}

/** 规范化 checkpoint 中可能缺失的授权状态 / Normalize authorization state from checkpoints */
export function normalizeAuthorizationState(
  authorization?: ThreadAuthorizationState | null,
): ThreadAuthorizationState {
  return {
    mode: authorization?.mode === "full_access" ? "full_access" : "default",
    commandGrants: authorization?.commandGrants ?? {},
  };
}

/** 生成 same_command 授权 key，不复用 approvalHash / Build same_command grant key without reusing approvalHash */
export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return createHash("sha256")
    .update(
      `same_command:${stableStringify({
        workspace: input.workspace,
        threadId: input.threadId,
        command: input.command.trim(),
      })}`,
    )
    .digest("hex");
}

/** 记录同 thread/workspace 下的精确命令授权 / Record an exact command grant for a thread/workspace */
export function grantSameCommand(
  authorization: ThreadAuthorizationState | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): ThreadAuthorizationState {
  const state = normalizeAuthorizationState(authorization);
  const command = input.command.trim();
  if (!command) {
    return state;
  }
  const key = commandGrantKey({ ...input, command });
  return {
    ...state,
    commandGrants: {
      ...state.commandGrants,
      [key]: {
        workspace: input.workspace,
        threadId: input.threadId,
        command,
      },
    },
  };
}

/** 检查 same_command 授权是否命中 / Check whether an exact command grant exists */
export function hasSameCommandGrant(
  authorization: ThreadAuthorizationState | null | undefined,
  input: { workspace: string; threadId: string; command: string },
): boolean {
  const state = normalizeAuthorizationState(authorization);
  const key = commandGrantKey(input);
  const grant = state.commandGrants[key];
  return (
    !!grant &&
    grant.workspace === input.workspace &&
    grant.threadId === input.threadId &&
    grant.command === input.command.trim()
  );
}

/** 根据用户选择更新当前 thread 授权状态 / Apply the user-selected grant to thread authorization state */
export function applyApprovalGrant(input: {
  authorization: ThreadAuthorizationState | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
}): ThreadAuthorizationState {
  const authorization = normalizeAuthorizationState(input.authorization);
  if (input.grant === "full_access") {
    return {
      ...authorization,
      mode: "full_access",
    };
  }
  if (input.grant === "same_command" && input.request.name === "shell_execute") {
    return grantSameCommand(authorization, {
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
    });
  }
  return authorization;
}

/** 从访问权限派生默认执行阶段 / Derive the default phase from workspace access */
export function defaultPhaseForWorkspaceAccess(
  workspaceAccess: WorkspaceAccess,
): AgentPhase {
  return workspaceAccess === "read-only" ? "planning" : "building";
}

/** 统一评估工具请求是否允许、是否需要审批以及用户可见风险 / Evaluate the unified tool safety policy */
export function evaluateToolPolicy(input: {
  request: PendingToolRequest;
  workspaceAccess: WorkspaceAccess;
  phase: AgentPhase;
  workspace?: string;
  threadId?: string;
  authorization?: ThreadAuthorizationState | null;
  override?: AuthorizationOverride;
}): ToolPolicyDecision {
  const { request, workspaceAccess, phase } = input;
  const authorization = normalizeAuthorizationState(input.authorization);
  const effectiveMode = input.override?.current ?? authorization.mode;

  if (request.name === "update_plan") {
    return allow({
      risk: "plan",
      reason: "Plan updates do not mutate the workspace.",
      userVisibleSummary: "Update the agent plan.",
      expectedEffects: ["Updates graph.state.plan only"],
    });
  }

  if (request.name === "ask_user") {
    return allow({
      risk: "plan",
      reason: "User clarification interrupts do not mutate the workspace.",
      userVisibleSummary: "Ask the user a focused clarification question.",
      expectedEffects: ["Interrupts for user input", "Does not read or write workspace files"],
    });
  }

  if (request.name === "read_file") {
    return allow({
      risk: "read",
      reason: "Read-only workspace inspection.",
      userVisibleSummary: `Read workspace data using ${request.name}.`,
      expectedEffects: ["Reads workspace files", "Does not intentionally mutate files"],
    });
  }

  if (request.name === "set_authorization_mode") {
    return allow({
      risk: "plan",
      reason: "Authorization mode changes do not mutate the workspace.",
      userVisibleSummary: `Set authorization mode to: ${request.args.mode}`,
      expectedEffects: [
        "Changes thread authorization mode",
        "Does not read or write workspace files",
      ],
    });
  }

  if (request.name === "shell_execute") {
    const authorized = authorizedShellDecision({
      authorization,
      workspace: input.workspace ?? "",
      threadId: input.threadId ?? "",
      command: request.args.command,
      effectiveMode,
    });
    if (authorized) {
      return authorized;
    }
    const shellDecision = classifyShellExecute(request.args.command);
    if (
      shellDecision.allowed &&
      !shellDecision.requiresApproval &&
      shellDecision.risk === "read"
    ) {
      return shellDecision;
    }
  }

  const phaseOrAccessDenial = denyForPlanningOrReadOnly({
    request,
    workspaceAccess,
    phase,
  });
  if (phaseOrAccessDenial) {
    return phaseOrAccessDenial;
  }

  if (request.name === "write_file" || request.name === "edit_file") {
    const path = request.args.path || "<unknown>";
    if (effectiveMode === "full_access") {
      return allow({
        risk: "write_file",
        reason: "full_access is enabled for this thread.",
        userVisibleSummary: `Modify workspace file: ${path}`,
        expectedEffects: [
          "Modifies files inside the workspace",
          "May overwrite existing content",
        ],
        grantUsed: "full_access",
      });
    }
    return requireApproval({
      risk: "write_file",
      reason: "This tool modifies workspace files.",
      userVisibleSummary: `Modify workspace file: ${path}`,
      expectedEffects: ["Modifies files inside the workspace", "May overwrite existing content"],
    });
  }

  if (request.name === "shell_execute") {
    return classifyShellExecute(request.args.command);
  }

  return deny({
    risk: "unknown",
    reason: `Unknown tool: ${(request as PendingToolRequest).name}`,
    userVisibleSummary: `Rejected unknown tool: ${(request as PendingToolRequest).name}`,
    expectedEffects: ["No tool will be executed"],
  });
}

/** 构建 runtime 生成的审批展示 payload / Build the runtime-generated approval payload */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: ToolPolicyDecision;
}): ToolApprovalPayload {
  const shellAction = input.request.name === "shell_execute" ? input.request.args : null;
  const grantOptions: ShellApprovalGrant[] =
    input.request.name === "shell_execute"
      ? ["approve_once", "same_command", "full_access"]
      : ["approve_once"];
  const requestedGrant = shellAction?.grant_request;
  return {
    scope: "once",
    cwd: input.workspace,
    threadId: input.threadId,
    tool: input.request.name,
    command: approvalCommand(input.request),
    risk: input.decision.risk,
    approvalHash: hashToolApprovalRequest(input),
    summary: input.decision.userVisibleSummary,
    reason: input.decision.reason,
    expectedEffects: input.decision.expectedEffects,
    modelJustification: shellAction?.justification,
    objective: shellAction?.objective,
    expectedObservation: shellAction?.expected_observation,
    failureStrategy: shellAction?.failure_strategy,
    suggestedPrefixRule: shellAction?.prefix_rule,
    grantOptions,
    recommendedGrant:
      requestedGrant && grantOptions.includes(requestedGrant)
        ? requestedGrant
        : "approve_once",
  };
}

/** 计算审批请求 hash，绑定工具参数、工作区和 thread / Hash the exact approval request */
export function hashToolApprovalRequest(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        tool: input.request.name,
        args: input.request.args,
        workspace: input.workspace,
        threadId: input.threadId,
      }),
    )
    .digest("hex");
}

/** 校验 resume 中的审批 hash / Validate approval hash from resume payload */
export function validateApprovalHash(
  resume: { approvalHash?: string },
  expectedHash: string,
): boolean {
  return resume.approvalHash === expectedHash;
}

/** 使用用户替换命令生成当前工具请求的覆盖版本 / Build a replacement command request for the current pending request */
export function replaceApprovalCommand(
  request: PendingToolRequest,
  replacementCommand: string,
): PendingToolRequest {
  const command = replacementCommand.trim();
  if (!command) {
    throw new Error("Replacement command must not be empty.");
  }

  if (request.name === "shell_execute") {
    return {
      ...request,
      args: { ...request.args, command },
      protectedCommand: command,
    };
  }

  throw new Error(`Tool ${request.name} does not support command replacement.`);
}

function classifyShellExecute(command: string): ToolPolicyDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return deny({
      risk: "unknown",
      reason: "shell_execute requires a non-empty command.",
      userVisibleSummary: "Rejected empty shell command.",
      expectedEffects: ["No command will be executed"],
    });
  }

  if (isDestructiveShellCommand(trimmed)) {
    return deny({
      risk: "destructive",
      reason: "Destructive shell commands are denied by default.",
      userVisibleSummary: `Rejected destructive shell command: ${trimmed}`,
      expectedEffects: ["No command will be executed"],
    });
  }

  if (isReadOnlyShellCommand(trimmed)) {
    return allow({
      risk: "read",
      reason: "Command is classified as read-only.",
      userVisibleSummary: `Run read-only shell command: ${trimmed}`,
      expectedEffects: ["Reads local workspace or git metadata", "Does not intentionally mutate files"],
    });
  }

  if (isVcsMutationCommand(trimmed)) {
    return requireApproval({
      risk: "vcs_mutation",
      reason: "This command mutates version-control state.",
      userVisibleSummary: `Run version-control mutation command: ${trimmed}`,
      expectedEffects: ["Mutates git state", "May change staged files, commits, or branches"],
    });
  }

  if (isWriteLikeShellCommand(trimmed)) {
    return requireApproval({
      risk: "write_file",
      reason: "This shell command may modify workspace files.",
      userVisibleSummary: `Run workspace-mutating shell command: ${trimmed}`,
      expectedEffects: ["May modify files inside the workspace", "May create cache, temp, or dependency output"],
    });
  }

  if (isNetworkCommand(trimmed)) {
    return requireApproval({
      risk: "network",
      reason: "This shell command may access the network.",
      userVisibleSummary: `Run network-capable shell command: ${trimmed}`,
      expectedEffects: ["May access network resources", "May write downloaded or generated output"],
    });
  }

  return requireApproval({
    risk: "execute_code",
    reason: "This shell command executes local project code or an arbitrary program.",
    userVisibleSummary: `Run shell command: ${trimmed}`,
    expectedEffects: ["Executes local project code", "May create cache or temporary output"],
  });
}

function authorizedShellDecision(input: {
  authorization: ThreadAuthorizationState;
  workspace: string;
  threadId: string;
  command: string;
  effectiveMode: AuthorizationMode;
}): ToolPolicyDecision | null {
  const trimmed = input.command.trim();
  if (!trimmed) {
    return null;
  }

  if (input.effectiveMode === "full_access") {
    return allow({
      risk: classifyShellRisk(trimmed),
      reason: "full_access is enabled for this thread.",
      userVisibleSummary: `Run shell command under full_access: ${trimmed}`,
      expectedEffects: [
        "Executes without additional shell approval in the current thread",
        "May read, write, delete, access network, or mutate version-control state",
      ],
      grantUsed: "full_access",
    });
  }

  if (
    hasSameCommandGrant(input.authorization, {
      workspace: input.workspace,
      threadId: input.threadId,
      command: trimmed,
    })
  ) {
    return allow({
      risk: classifyShellRisk(trimmed),
      reason: "same_command grant matches this exact command in the current thread and workspace.",
      userVisibleSummary: `Run previously approved shell command: ${trimmed}`,
      expectedEffects: [
        "Executes the exact command previously approved for this thread and workspace",
      ],
      grantUsed: "same_command",
    });
  }

  return null;
}

function denyForPlanningOrReadOnly(input: {
  request: PendingToolRequest;
  workspaceAccess: WorkspaceAccess;
  phase: AgentPhase;
}): ToolPolicyDecision | null {
  if (input.workspaceAccess === "read-only") {
    return deny({
      risk: requestRisk(input.request),
      reason: "read-only workspace access allows read-only tools only.",
      userVisibleSummary: `Rejected ${input.request.name} under read-only workspace access.`,
      expectedEffects: ["No workspace mutation or code execution will run"],
    });
  }

  if (input.phase === "planning") {
    return deny({
      risk: requestRisk(input.request),
      reason: "planning phase allows read-only inspection and plan updates only.",
      userVisibleSummary: `Rejected ${input.request.name} during planning phase.`,
      expectedEffects: ["No workspace mutation or code execution will run"],
    });
  }

  return null;
}

function requestRisk(request: PendingToolRequest): ToolRisk {
  if (request.name === "edit_file" || request.name === "write_file") {
    return "write_file";
  }
  if (request.name === "shell_execute") {
    return classifyShellRisk(request.args.command);
  }
  return "unknown";
}

function classifyShellRisk(command: string): ToolRisk {
  if (isDestructiveShellCommand(command)) return "destructive";
  if (isVcsMutationCommand(command)) return "vcs_mutation";
  if (isWriteLikeShellCommand(command)) return "write_file";
  if (isNetworkCommand(command)) return "network";
  return "execute_code";
}

function isDestructiveShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(?:^|[;&|]\s*)sudo\b/.test(normalized) ||
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r)\b/.test(normalized) ||
    /\bcurl\b.+\|\s*(?:sh|bash)\b/.test(normalized) ||
    /\bwget\b.+\|\s*(?:sh|bash)\b/.test(normalized) ||
    /\bgit\s+push\b/.test(normalized) ||
    /\bgit\s+reset\s+--hard\b/.test(normalized) ||
    /\bgit\s+clean\s+-[^\s]*f/.test(normalized) ||
    /\bchmod\s+-[^\s]*r\b/.test(normalized) ||
    /\bchown\s+-[^\s]*r\b/.test(normalized) ||
    /(?:^|[;&|]\s*)kill(?:all)?\b/.test(normalized)
  );
}

function isVcsMutationCommand(command: string): boolean {
  return /\bgit\s+(?:add|commit|checkout|switch|merge|rebase|tag|restore|stash|pull|fetch)\b/.test(
    normalizeShell(command),
  );
}

function isWriteLikeShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(^|[^>])>{1,2}($|[^>])/.test(normalized) ||
    /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|tee)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update)\b/.test(normalized)
  );
}

function isNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget)\b/.test(normalizeShell(command));
}

function normalizeShell(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, " ");
}

function approvalCommand(request: PendingToolRequest): string {
  if (request.name === "shell_execute") {
    return request.args.command;
  }
  return request.protectedCommand;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function allow(
  input: Omit<ToolPolicyDecision, "allowed" | "requiresApproval" | "grantUsed"> & {
    grantUsed?: ShellGrantUsed;
  },
): ToolPolicyDecision {
  return {
    allowed: true,
    requiresApproval: false,
    grantUsed: input.grantUsed ?? "none",
    ...input,
  };
}

function requireApproval(
  input: Omit<ToolPolicyDecision, "allowed" | "requiresApproval" | "grantUsed"> & {
    grantUsed?: ShellGrantUsed;
  },
): ToolPolicyDecision {
  return {
    allowed: true,
    requiresApproval: true,
    grantUsed: input.grantUsed ?? "none",
    ...input,
  };
}

function deny(
  input: Omit<ToolPolicyDecision, "allowed" | "requiresApproval" | "grantUsed"> & {
    grantUsed?: ShellGrantUsed;
  },
): ToolPolicyDecision {
  return {
    allowed: false,
    requiresApproval: false,
    grantUsed: input.grantUsed ?? "none",
    ...input,
  };
}
