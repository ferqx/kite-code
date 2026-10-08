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
  /** Display only: a unique original Model call in the already observed history. */
  target?: string;
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
