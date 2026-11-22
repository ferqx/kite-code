import type { Execution, Message, Run } from '@kite-ai/client';
import { nativeToolRequestTarget } from './tool-request-target';

/** Budget for added command fragments; existing metadata retains the original IPC response cap. */
export const nativeToolMessagePageBytes = 524288;
/** Shell bodies are budgeted separately from commands and other tool facts. */
export const nativeShellOutputPageBytes = 2 * 1024 * 1024;
export const nativeShellCommandChunkBytes = 8192;
export const nativeAgentWaitErrors = [
  'invalid_cursor',
  'cursor_expired',
  'invalid_request',
  'invalid_work_reference',
  'agent_unavailable',
  'permission_denied',
  'operation_cancelled',
  'receipt_unverifiable',
] as const;
/** Display-only failure facts from the exact registered Git worktree receipt. */
export type NativeWorktreeFailure = {
  category:
    | 'process_start'
    | 'permission_denied'
    | 'git_command'
    | 'verification'
    | 'authorization_denied'
    | 'unclassified';
  mutation: 'not_started' | 'completed' | 'partial' | 'unknown';
  errno?: string;
  exitCode?: number;
  cleanupUnconfirmed?: true;
};
export type NativeShellInput = {
  operation: 'execute' | 'launch' | 'read' | 'wait' | 'stop';
  shellId?: string;
  /** Original command fragment; offsets count UTF-16 units without splitting a code point. */
  command?: string;
  commandOffset?: number;
  commandNextOffset?: number | null;
};

export type NativeToolMessageScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
export type NativeToolMessageFact = Pick<
  Execution,
  'definitionId' | 'definitionVersion' | 'status' | 'resultRevision'
> & {
  messageId: string;
  executionId: string;
  /** Core-confirmed pre-dispatch freshness rejection; the original Execution remains failed. */
  decisionRefresh?: 'context_refresh_required' | 'capability_refresh_required';
  /** Exact successful builtin Files read receipt: the requested file is absent. */
  fileMissing?: true;
  /** An exact builtin Files receipt proves the write created the file. */
  fileCreated?: true;
  /** Exact builtin Task queue acknowledgment; display only, never proof of receipt or execution. */
  agentMessageAccepted?: true;
  agentWait?:
    | { reason: 'events' | 'completed' | 'input' | 'timeout'; events: number; historyGap?: true }
    | { reason: 'failed'; code: (typeof nativeAgentWaitErrors)[number] };
  /** Safe page accounting from the original saved builtin Web Fetch receipt. */
  webFetchBatch?: NonNullable<import('@kite-ai/ui/desktop').Message['webFetchBatch']>;
  /** Display only: verified request fields, a known directory default or the saved plan read location. */
  target?: string;
  /** Original request presentation is still being verified; never publish a partial tool row. */
  inputPending?: boolean;
  /** Name verified against original saved MCP metadata; display only. */
  label?: string;
  shellInput?: NativeShellInput;
  /** Exact request owner for a scoped live input; never a result or control capability. */
  inputSource?: { storeId: string; sessionId: string; runId: string; toolCallId: string };
  /** Exact known Shell result content equals its saved structured details. */
  shellResultVerified?: boolean;
  /** Original Job identity and, when observed, a proved background command exit. */
  shellJobExecutionId?: string;
  shellJobSettlement?: { jobStatus: 'succeeded' | 'failed'; exitCode?: number };
  /** Host-verified status for a receipt whose message body is already the model output. */
  shellOutputReceipt?: Pick<
    NonNullable<import('@kite-ai/ui/desktop').Message['shell']>,
    'jobStatus' | 'exitCode' | 'timedOut' | 'outputComplete' | 'failureReason'
  >;
  /** Original call and frozen model budget for a legacy Shell receipt. */
  shellOutputLimit?: { requestedTokens?: number; modelTokenLimit?: number };
  /** Deferred receipts carry only the verified output projection, never the raw receipt. */
  shellDisplay?: Pick<
    NonNullable<import('@kite-ai/ui/desktop').Message['shell']>,
    | 'output'
    | 'failureReason'
    | 'jobStatus'
    | 'exitCode'
    | 'timedOut'
    | 'outputComplete'
    | 'accepted'
    | 'cancelRequested'
  >;
  shellOutputError?: true;
  worktreeFailure?: NativeWorktreeFailure;
  /** Original image/PDF metadata, loaded through the same bounded image reader. */
  images?: { name: string; reference: { mediaType: string; size: string } }[];
  /** Verified history image observation, without granting an image reader. */
  reinspectedImages?: number;
  imageSourcesListed?: true;
  /** Read-only original Execution authorization; never a grant or answer capability. */
  authorization?: Execution['authorization'];
  /** Known ask_user v1 request and successful result; no Interaction authority. */
  ask?: {
    questions: { id: string; question: string }[];
    answers?: Record<string, string>;
    summary?: string;
    cancelled?: boolean;
  };
};
export type NativeToolMessagePage = {
  kind: 'toolMessages.page';
  readId: string;
  scope: NativeToolMessageScope;
  entries: NativeToolMessageFact[];
};
export type NativeToolRunPage = {
  kind: 'toolMessages.runs';
  readId: string;
  scope: NativeToolMessageScope;
  runs: NativeRunFact[];
};
export type NativeContextUsage = {
  modelId: string;
  contextSelectionId: string;
  totalInputTokens: number;
  contextWindowTokens?: number;
};
export type NativeContextUsagePage = {
  kind: 'toolMessages.contextUsage';
  readId: string;
  scope: NativeToolMessageScope;
  context?: NativeContextUsage;
};
export type NativeModelUsageFact = {
  messageId: string;
  executionId: string;
  originStoreId: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
};
export type NativeModelUsagePage = {
  kind: 'toolMessages.usage';
  readId: string;
  scope: NativeToolMessageScope;
  entries: NativeModelUsageFact[];
};
export function modelUsageMessageKey(message: Message): string {
  return JSON.stringify([
    message.id,
    message.sessionId,
    message.seq,
    message.runId,
    message.role,
    message.status,
    message.contentFormat,
    message.sourceIds,
    message.originMessage,
    message.outputBody,
  ]);
}
export type NativeRunFact = Pick<
  Run,
  | 'id'
  | 'originStoreId'
  | 'sessionId'
  | 'status'
  | 'isActive'
  | 'createdAt'
  | 'finishedAt'
  | 'reason'
> &
  Partial<Pick<Run, 'originCommandId'>>;

/** Display facts only; no result body, request payload, or control capability. */
export type NativeToolExecution = Pick<
  Execution,
  | 'id'
  | 'originStoreId'
  | 'sessionId'
  | 'runId'
  | 'kind'
  | 'definitionId'
  | 'definitionVersion'
  | 'status'
  | 'resultRevision'
  | 'authorization'
  | 'cancelRequestedAt'
  | 'parentExecutionId'
> & {
  target?: string;
  inputReady?: boolean;
  modelRetry?: Execution['modelRetry'];
  result?: Execution['result'];
  shellExitCode?: number;
};

export function nativeShellExitCode(execution: NativeToolExecution): number | undefined {
  if (
    execution.kind !== 'job' ||
    execution.definitionId !== 'shell.command' ||
    execution.definitionVersion !== '1' ||
    execution.status !== 'failed'
  )
    return;
  const result = execution.result;
  const details =
    result && typeof result === 'object' && !Array.isArray(result) && result.outcome === 'failed'
      ? result.details
      : undefined;
  const code =
    details && typeof details === 'object' && !Array.isArray(details)
      ? details.exitCode
      : undefined;
  return typeof code === 'number' && Number.isSafeInteger(code) && code !== 0 ? code : undefined;
}

type ShellLaunchIdentity = Pick<NativeToolExecution, 'originStoreId' | 'sessionId' | 'runId'> & {
  executionId: string;
  jobExecutionId: string;
};

export function nativeShellJobMatches(
  job: NativeToolExecution | undefined,
  tool: ShellLaunchIdentity,
): job is NativeToolExecution {
  return (
    job?.id === tool.jobExecutionId &&
    job.kind === 'job' &&
    job.definitionId === 'shell.command' &&
    job.definitionVersion === '1' &&
    job.parentExecutionId === tool.executionId &&
    !!tool.originStoreId &&
    job.originStoreId === tool.originStoreId &&
    job.sessionId === tool.sessionId &&
    // Runtime Jobs keep their parent Execution but are not attached directly to a Run.
    (job.runId === null || job.runId === tool.runId)
  );
}

export function nativeShellJobSettlement(
  job: NativeToolExecution | undefined,
  tool: ShellLaunchIdentity,
): NativeToolMessageFact['shellJobSettlement'] {
  if (!nativeShellJobMatches(job, tool)) return;
  if (job.status === 'succeeded') return { jobStatus: 'succeeded' };
  const exitCode = job.shellExitCode ?? nativeShellExitCode(job);
  return job.status === 'failed' && exitCode !== undefined
    ? { jobStatus: 'failed', exitCode }
    : undefined;
}

export function nativeRunFact(run: NativeRunFact): NativeRunFact {
  const {
    id,
    originStoreId,
    originCommandId,
    sessionId,
    status,
    isActive,
    createdAt,
    finishedAt,
    reason,
  } = run;
  return {
    id,
    originStoreId,
    originCommandId,
    sessionId,
    status,
    isActive,
    createdAt,
    finishedAt,
    reason,
  };
}

export function nativeToolExecution(
  execution: NativeToolExecution & Partial<Pick<Execution, 'toolInput'>>,
): NativeToolExecution {
  const {
    id,
    originStoreId,
    sessionId,
    runId,
    kind,
    definitionId,
    definitionVersion,
    status,
    resultRevision,
    authorization,
    cancelRequestedAt,
    parentExecutionId,
  } = execution;
  return {
    id,
    originStoreId,
    sessionId,
    runId,
    kind,
    definitionId,
    definitionVersion,
    status,
    resultRevision,
    authorization,
    cancelRequestedAt,
    parentExecutionId,
    shellExitCode: nativeShellExitCode(execution),
    target: definitionId.startsWith('shell.')
      ? undefined
      : nativeToolRequestTarget(execution.toolInput, definitionId, definitionVersion),
    inputReady: execution.toolInput !== undefined,
  };
}

/** Restored terminal facts retain their original Store; they grant no active authority. */
export function presentableRun(run: NativeRunFact, storeId: string, sessionId: string): boolean {
  return (
    run.sessionId === sessionId &&
    (run.originStoreId === storeId ||
      (!run.isActive && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)))
  );
}

export type NativeToolMessageRequest =
  | {
      method: 'toolMessages.contextUsage';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | {
      method: 'toolMessages.usage';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | {
      method: 'toolMessages.list';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
      commandOffsets?: Record<string, number>;
      /** Current-scope observed live Tools; messageIds must be empty for this mode. */
      executionIds?: string[];
    }
  | {
      method: 'toolMessages.runs';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | { method: 'toolMessages.close'; generation: number; readId: string };
