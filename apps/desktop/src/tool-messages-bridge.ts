import type { Execution } from '@kite-ai/client';

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
};
export type NativeToolMessagePage = {
  kind: 'toolMessages.page';
  readId: string;
  scope: NativeToolMessageScope;
  entries: NativeToolMessageFact[];
};
export type NativeToolMessageRequest =
  | {
      method: 'toolMessages.list';
      generation: number;
      viewSelection: number;
      historyEpoch: number;
      readId: string;
      messageIds: string[];
    }
  | { method: 'toolMessages.close'; generation: number; readId: string };
