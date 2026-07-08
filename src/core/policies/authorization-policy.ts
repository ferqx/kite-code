import { createHash } from 'node:crypto';
import type { ThreadAuthorizationState } from '@/core/types';
import type { ShellApprovalGrant } from '@/protocol/events';

// ── 本地类型 / Local types ──

/** 工具风险评估等级 / Tool risk assessment tier */
export type ToolRisk =
  | 'read'
  | 'plan'
  | 'write_file'
  | 'execute_code'
  | 'destructive'
  | 'network'
  | 'vcs_mutation'
  | 'mcp'
  | 'unknown';

/** 工具请求最小形状，避免依赖 harness 的 PendingToolRequest / Minimal tool request shape, harness-independent */
interface ToolRequestShape {
  name: string;
  args: Record<string, unknown>;
}

// ── 状态工厂 / State factories ──

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
    commandGrants: authorization?.commandGrants ?? {},
  };
}

// ── same_command 授权核心 / Same-command grant core ──

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
  input: { workspace: string; threadId: string; command: string },
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
  request: ToolRequestShape;
}): ThreadAuthorizationState {
  const authorization = normalizeAuthorizationState(input.authorization);
  if (input.grant === 'full_access') {
    return {
      ...authorization,
      mode: 'full_access',
    };
  }
  if (input.grant === 'same_command' && input.request.name === 'shell_execute') {
    return grantSameCommand(authorization, {
      workspace: input.workspace,
      threadId: input.threadId,
      command: input.request.args.command as string,
    });
  }
  return authorization;
}

// ── shell 命令风险分类 / Shell command risk classification ──

/** 根据 shell 命令内容判定工具风险等级 / Classify the tool risk tier for a shell command */
export function classifyShellRisk(command: string): ToolRisk {
  if (isDestructiveShellCommand(command)) return 'destructive';
  if (isVcsMutationCommand(command)) return 'vcs_mutation';
  if (isWriteLikeShellCommand(command)) return 'write_file';
  if (isNetworkCommand(command)) return 'network';
  return 'execute_code';
}

// ── 审批 hash / Approval hash ──

/** 计算审批请求 hash，绑定工具参数、工作区和 thread / Hash the exact approval request */
export function hashToolApprovalRequest(input: {
  workspace: string;
  threadId: string;
  request: ToolRequestShape;
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

// ── 稳定序列化 / Stable serialization ──

/** 确定性 JSON 序列化，对象 key 按字母序排列 / Deterministic JSON serialization with lexicographic key ordering */
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

// ── 内部 shell 命令检测辅助 / Internal shell command detection helpers ──

function isDestructiveShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(?:(?:^|[;&|]\s*)|\/)sudo\b/.test(normalized) ||
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r|--recursive.*--force|--force.*--recursive)\b/.test(
      normalized,
    ) ||
    /\brm\s+-[^\s]*f\b/.test(normalized) ||
    /\bchmod\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /\bchown\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /(?:(?:^|[;&|]\s*)|\/)kill(?:all)?\b/.test(normalized) ||
    /\bdd\b.*\bof=\/dev\//.test(normalized) ||
    /\bmkfs\b/.test(normalized) ||
    /\b(?:shutdown|reboot|halt|poweroff)\b/.test(normalized) ||
    /\binit\s+[06]\b/.test(normalized) ||
    /\bfdisk\b/.test(normalized) ||
    /\bparted\b/.test(normalized) ||
    /:\(\)\s*\{.*:.*\|.*:.*\}/.test(normalized) ||
    />\s*\/dev\/sd/.test(normalized)
  );
}

function isVcsMutationCommand(command: string): boolean {
  return /\bgit\s+(?:add|clone|commit|checkout|switch|merge|rebase|tag|restore|stash|pull|fetch|push|reset|clean)\b/.test(
    normalizeShell(command),
  );
}

function isWriteLikeShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(^|[^>])>{1,2}(?!&[12])(?:$|[^>])/.test(normalized) ||
    /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|tee|rm|unlink)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update)\b/.test(normalized) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+install\b/.test(normalized)
  );
}

function isNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget)\b/.test(normalizeShell(command));
}

function normalizeShell(command: string): string {
  return (command ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
