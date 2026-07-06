import type { AuthorizationMode, ShellApprovalGrant } from '@/protocol/events';

export interface ShellInput {
  workspace: string;
  command: string;
  /** 中止信号，取消时 kill 子进程 / Abort signal to kill child process on cancellation */
  signal?: AbortSignal;
  /** 最大运行时间（毫秒）；超时后终止子进程 / Max runtime in milliseconds; kills child on timeout */
  timeoutMs?: number;
  /** 实时输出回调 — shell 进程每产生一行文本时调用 / Called per output line while shell process is running */
  onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellIntent = 'inspect' | 'verify' | 'build' | 'test' | 'git' | 'other';

export interface ShellActionEnvelope {
  command: string;
  description?: string;
  intent?: ShellIntent;
  objective?: string;
  justification?: string;
  expected_observation?: string;
  failure_strategy?: string;
  timeout_ms?: number;
  prefix_rule?: string[];
  grant_request?: ShellApprovalGrant;
}

export interface ThreadAuthorizationState {
  mode: 'default' | 'full_access';
  commandGrants: Record<string, { workspace: string; threadId: string; command: string }>;
}

export interface AuthorizationOverride {
  current: AuthorizationMode;
}

export interface ApplyPatchInput {
  workspace: string;
  path: string;
  content: string;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  message: string;
}

export type ToolApprovalResumeValue =
  | boolean
  | {
      approved?: boolean;
      grant?: ShellApprovalGrant;
      approvalHash?: string;
      replacementCommand?: string;
      reason?: string;
    };

export type UserInputResumeValue =
  | string
  | {
      answer?: string;
      choice?: string;
      option_id?: string;
      optionId?: string;
      free_text?: string;
      freeText?: string;
      text?: string;
      answers?: Record<string, string>;
    };

export type PlanReviewResumeValue =
  | boolean
  | {
      planApproved?: boolean;
      planSupplement?: string;
      /** auto means auto confirmation, not full_access. manual means ask/default confirmation. */
      executionMode?: 'auto' | 'manual';
    };

export type AgentResumeValue =
  | ToolApprovalResumeValue
  | UserInputResumeValue
  | PlanReviewResumeValue;

/** 上下文预算配置 / Context budget configuration */
export interface ContextBudget {
  /** 模型上下文窗口最大 token 数（0 表示不限制）/ Maximum tokens in the model context window (0 = no limit). Required for M2 soft/hard thresholds (shouldCompact). */
  maxTokens?: number;
  /** M1: 保留的最近消息数（活跃窗口大小，不折叠）/ Number of most recent messages to keep un-compacted (default 6) */
  recentWindowSize?: number;
  /** M2(预留): 软压缩触发阈值（maxTokens 的比例，默认 0.75）/ Soft compaction trigger threshold as fraction of maxTokens (default 0.75) */
  compactionThreshold?: number;
}

export interface ModelRetryEvent {
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
}
