import type { Execution, Message, Run } from '@kite-ai/client';

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
  /** Display only: unique original Model call fields, or its known version's directory default. */
  target?: string;
  /** Original PDF page image metadata, loaded through the same bounded image reader. */
  images?: { name: string; reference: { mediaType: string; size: string } }[];
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
>;

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
>;

export function nativeRunFact(run: NativeRunFact): NativeRunFact {
  const { id, originStoreId, sessionId, status, isActive, createdAt, finishedAt, reason } = run;
  return { id, originStoreId, sessionId, status, isActive, createdAt, finishedAt, reason };
}

export function nativeToolExecution(execution: NativeToolExecution): NativeToolExecution {
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
