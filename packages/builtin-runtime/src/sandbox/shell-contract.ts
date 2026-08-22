import type {
  SandboxExecutionProviderFailureCodeV1,
  SandboxPreparationLifecycleV1,
} from '@kite/runtime-spi';
import type { NetworkDecisionRecorderV1 } from './network-enforcer';
import type { NetworkBoundaryPolicyV1 } from './network-policy';
import type { ShellFilesystemMode, ShellNetworkMode } from './types';

/** Runtime identity bound to one governed shell invocation. */
export interface SandboxInvocationIdentityV1 {
  toolCallId: string;
  capabilityId: string;
  capabilityRevision: string;
  invocationId: string;
  attempt: number;
  effectiveEffectsDigest: string;
  admissionDigest: string;
  cancellationCorrelation: string;
}

export interface ShellNetworkBrokerV1 {
  policy: NetworkBoundaryPolicyV1;
  toolCallId: string;
  recordDecision: NetworkDecisionRecorderV1;
}

/** Generic process-tree result supplied by the Runtime Host. */
export interface ShellProcessTerminationV1 {
  readonly confirmedExited: boolean;
  readonly gracefulRequested: boolean;
  readonly forced: boolean;
  readonly unconfirmedProcessCount: number;
}

/** Generic process-tree lifecycle supplied by the Runtime Host. */
export interface ShellProcessTreeV1 {
  terminate(): Promise<ShellProcessTerminationV1>;
  dispose(): void;
}

/** Generic process handle; Shell semantics never touch Bun.spawn directly. */
export interface ShellProcessHandleV1 {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly processTree: ShellProcessTreeV1;
}

/** Host-provided generic process mechanism used by the Builtin Shell executor. */
export interface ShellProcessPortV1 {
  spawn(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }): ShellProcessHandleV1;
  readOutput(
    stream: ReadableStream<Uint8Array>,
    onLine?: (line: string) => void,
    stopSignal?: AbortSignal,
  ): Promise<string>;
}

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
  /** Filesystem authority for this invocation; allow_all requires a user-derived grant. */
  filesystemMode?: ShellFilesystemMode;
  /** Runtime-authored execution trust. Models and approval payloads cannot set this field. */
  executionTrust?: 'policy_proven_read_only';
  /** Capability-token host broker for an explicit `kite-http` request inside
   * the Windows sandbox. This does not enable descendant direct networking. */
  networkBroker?: ShellNetworkBrokerV1;
  /** Runtime-only identity used by the governed SandboxExecutionProviderV1 consumer. */
  sandboxInvocationIdentity?: SandboxInvocationIdentityV1;
  /** Runtime-owned durable allocating-preparation lifecycle; never model supplied. */
  sandboxPreparationLifecycle?: SandboxPreparationLifecycleV1;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Runtime-authored process terminal cause; never inferred from stderr. */
  terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  /**
   * Structured sandbox refusal authority. App composition may select the
   * already-authorized host Shell only when the user command never started
   * and allocating cleanup was durably confirmed.
   */
  sandboxFailure?: {
    code: SandboxExecutionProviderFailureCodeV1;
    stage: 'pre_dispatch' | 'post_dispatch';
    cleanupConfirmed: boolean;
  };
  processCleanup?: {
    confirmedExited: boolean;
    gracefulRequested: boolean;
    forced: boolean;
    unconfirmedDescendantCount: number;
  };
}

export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;
