import { createHash } from 'node:crypto';
import type { ApprovalDecision } from '@/core/policies/approval-policy';
import type { ToolRisk } from '@/core/policies/shell-classification';
import type { ThreadAuthorizationState } from '@/core/types';
import type { AgentPhase, ShellApprovalGrant, WorkspaceAccess } from '@/protocol/events';
import type { PendingToolRequest } from './tool-requests';

export type { ToolRisk };

export interface ToolApprovalPayload {
  scope: 'once';
  callId?: string;
  cwd: string;
  threadId: string;
  tool: PendingToolRequest['name'];
  command: string;
  risk: ToolRisk;
  approvalHash: string;
  summary: string;
  reason: string;
  expectedEffects: string[];
  suggestedPrefixRule?: string[];
  grantOptions: ShellApprovalGrant[];
  recommendedGrant: ShellApprovalGrant;
  subagentId?: string;
  reviewFailure?: string;
}

/** 创建默认 thread 授权状态 / Create default thread authorization state */
export function defaultAuthorizationState(): ThreadAuthorizationState {
  return {
    mode: 'default',
    commandGrants: {},
  };
}

/** 规范化 checkpoint 中可能缺失的授权状态 / Normalize authorization state from checkpoints */
export function normalizeAuthorizationState(
  authorization?: ThreadAuthorizationState | null,
): ThreadAuthorizationState {
  return {
    mode: authorization?.mode === 'full_access' ? 'full_access' : 'default',
    ...(authorization?.modeSource ? { modeSource: authorization.modeSource } : {}),
    ...(authorization?.modeGrantedAt ? { modeGrantedAt: authorization.modeGrantedAt } : {}),
    commandGrants: authorization?.commandGrants ?? {},
  };
}

/** 生成 same_command 授权 key，不复用 approvalHash / Build same_command grant key without reusing approvalHash */
export function commandGrantKey(input: {
  workspace: string;
  threadId: string;
  command: string;
}): string {
  return createHash('sha256')
    .update(
      `same_command:${stableStringify({
        workspace: input.workspace,
        threadId: input.threadId,
        command: (input.command ?? '').trim(),
      })}`,
    )
    .digest('hex');
}

/** 记录同 thread/workspace 下的精确命令授权 / Record an exact command grant for a thread/workspace */
export function grantSameCommand(
  authorization: ThreadAuthorizationState | null | undefined,
  input: {
    workspace: string;
    threadId: string;
    command: string;
    source?: import('@/core/types').AuthorizationSource;
  },
): ThreadAuthorizationState {
  const state = normalizeAuthorizationState(authorization);
  const command = (input.command ?? '').trim();
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
        source: input.source ?? 'user',
        grantedAt: new Date().toISOString(),
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
    grant.command === (input.command ?? '').trim()
  );
}

/** 根据用户选择更新当前 thread 授权状态 / Apply the user-selected grant to thread authorization state */
export function applyApprovalGrant(input: {
  authorization: ThreadAuthorizationState | null | undefined;
  grant: ShellApprovalGrant;
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  source?: import('@/core/types').AuthorizationSource;
}): ThreadAuthorizationState {
  const authorization = normalizeAuthorizationState(input.authorization);
  if (input.grant === 'full_access') {
    return {
      ...authorization,
      mode: 'full_access',
      modeSource: input.source ?? 'user',
      modeGrantedAt: new Date().toISOString(),
    };
  }
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return grantSameCommand(authorization, {
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command,
      source: input.source,
    });
  }
  return authorization;
}

/** 从访问权限派生默认执行阶段 / Derive the default phase from workspace access */
export function defaultPhaseForWorkspaceAccess(_workspaceAccess: WorkspaceAccess): AgentPhase {
  return 'building';
}

/** 构建 runtime 生成的审批展示 payload / Build the runtime-generated approval payload */
export function buildToolApproval(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
  decision: ApprovalDecision;
}): ToolApprovalPayload {
  const shellAction = input.request.name === 'shell_execute' ? input.request.args : null;
  const grantOptions: ShellApprovalGrant[] =
    input.request.name === 'shell_execute'
      ? ['approve_once', 'same_command', 'full_access']
      : ['approve_once'];
  const requestedGrant = shellAction?.grant_request;
  return {
    scope: 'once',
    ...(input.request.id ? { callId: input.request.id } : {}),
    cwd: input.workspace,
    threadId: input.threadId,
    tool: input.request.name,
    command: approvalCommand(input.request),
    risk: input.decision.risk,
    approvalHash: hashToolApprovalRequest(input),
    summary: input.decision.userVisibleSummary,
    reason: input.decision.reason,
    expectedEffects: input.decision.expectedEffects,
    suggestedPrefixRule: shellAction?.prefix_rule,
    grantOptions,
    recommendedGrant:
      requestedGrant && grantOptions.includes(requestedGrant) ? requestedGrant : 'approve_once',
  };
}

/** 计算审批请求 hash，绑定工具参数、工作区和 thread / Hash the exact approval request */
export function hashToolApprovalRequest(input: {
  workspace: string;
  threadId: string;
  request: PendingToolRequest;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        tool: input.request.name,
        args: input.request.args,
        workspace: input.workspace,
        threadId: input.threadId,
      }),
    )
    .digest('hex');
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
    throw new Error('Replacement command must not be empty.');
  }

  if (request.name === 'shell_execute') {
    return {
      ...request,
      args: { ...request.args, command },
      protectedCommand: command,
    };
  }

  throw new Error(`Tool ${request.name} does not support command replacement.`);
}

export { classifyShellRisk } from '@/core/policies/shell-classification';

function approvalCommand(request: PendingToolRequest): string {
  if (request.name === 'shell_execute') {
    return request.args.command;
  }
  return request.protectedCommand;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
