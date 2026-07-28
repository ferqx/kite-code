import type { AuthorizationMode, ShellApprovalGrant } from '@/protocol/events';

/** 单次 Shell 调用的沙箱网络权限 / Per-invocation sandbox network permission */
export type ShellNetworkMode = 'disabled' | 'allow_all';
export type ShellExecutionBoundary =
  | 'sandboxed_seatbelt'
  | 'sandboxed_bubblewrap'
  | 'unsandboxed_bash'
  | 'unsandboxed_shell';

export interface ShellInput {
  workspace: string;
  command: string;
  /** 中止信号，取消时 kill 子进程 / Abort signal to kill child process on cancellation */
  signal?: AbortSignal;
  /** 最大运行时间（毫秒）；超时后终止子进程 / Max runtime in milliseconds; kills child on timeout */
  timeoutMs?: number;
  /** 实时输出回调 — shell 进程每产生一行文本时调用 / Called per output line while shell process is running */
  onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** 本次调用的网络权限；未指定时使用执行器默认值 / Network permission for this call */
  networkMode?: ShellNetworkMode;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Actual execution boundary used for this invocation. */
  executionBoundary?: ShellExecutionBoundary;
}

export type ShellIntent = 'inspect' | 'verify' | 'build' | 'test' | 'git' | 'other';

export interface ShellActionEnvelope {
  command: string;
  description?: string;
  timeout_ms?: number;
}

export type AuthorizationSource = 'user' | 'config' | 'test' | 'system';

export interface ToolGrant {
  workspace: string;
  threadId: string;
  command: string;
  /** 授权来源 / Authorization source */
  source: AuthorizationSource;
  /** 授权时间 / Grant timestamp */
  grantedAt: string;
  expiresAt?: string;
}

export interface ThreadAuthorizationState {
  mode: 'default' | 'full_access';
  modeSource?: AuthorizationSource;
  modeGrantedAt?: string;
  commandGrants: Record<string, ToolGrant>;
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
      /** auto means auto-review, accept_edits means auto file edits + manual shell. */
      executionMode?: 'auto' | 'accept_edits';
    };

export type AgentResumeValue =
  | ToolApprovalResumeValue
  | UserInputResumeValue
  | PlanReviewResumeValue;

export interface ModelRetryEvent {
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
}
