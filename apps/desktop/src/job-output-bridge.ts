import type { ExecutionOutputPage } from '@kite-ai/client';

export const nativeJobOutputPageBytes = 524288;
export type NativeJobOutputScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
  executionId: string;
};
export type NativeJobOutputRequest =
  | {
      method: 'jobOutput.open';
      generation: number;
      readId: string;
      viewSelection: number;
      historyEpoch: number;
      executionId: string;
    }
  | { method: 'jobOutput.next' | 'jobOutput.close'; generation: number; readId: string };
export type NativeJobOutputPage = {
  kind: 'jobOutput.page';
  readId: string;
  scope: NativeJobOutputScope;
  afterSeq: string;
  upperSeq: string;
  nextAfterSeq: string;
  complete: boolean;
  page: ExecutionOutputPage;
};
