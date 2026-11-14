import type {
  BackgroundExecutionItem,
  Execution,
  Message,
  ModelOutputSnapshot,
  Run,
  Session,
  SessionView,
} from '@kite-ai/client';
import type { NativeFileChange } from './file-changes-bridge';
import type { NativeJobOutputPage } from './job-output-bridge';
import type {
  NativeRunFact,
  NativeToolExecution,
  NativeToolMessageFact,
} from './tool-messages-bridge';

export const nativeBackgroundPageBytes = 524288;
export type NativeBackgroundRequest = (
  | { method: 'background.open'; generation: number; readId: string }
  | { method: 'background.next' | 'background.close'; generation: number; readId: string }
  | {
      method: 'background.stop';
      generation: number;
      observationId: number;
      executionId: string;
      commandId: string;
    }
  | {
      method: 'background.output.open';
      generation: number;
      observationId: number;
      executionId: string;
      readId: string;
    }
  | {
      method: 'background.child.open';
      cursor?: { afterSeq: string; contextSelectionId: string };
      generation: number;
      observationId: number;
      executionId: string;
      readId: string;
    }
  | {
      method: 'background.output.next' | 'background.output.close' | 'background.child.close';
      generation: number;
      readId: string;
    }
  | {
      method: 'background.child.read';
      generation: number;
      readId: string;
      offset: number;
      limit: number;
    }
  | {
      method: 'background.child.file';
      generation: number;
      changeId: string;
      readId: string;
      offset?: number;
      view?: 'diff' | 'snapshot';
    }
  | { method: 'background.child.file.close'; generation: number; readId: string }
  | { method: 'background.child.text'; generation: number; handle: string; offset: string }
  | {
      method: 'background.child.image.open';
      generation: number;
      handle: string;
      readId: string;
      index: number;
    }
  | { method: 'background.child.image.read'; generation: number; readId: string; offset: number }
  | { method: 'background.child.image.close'; generation: number; readId: string }
) & { surface?: 'environment' };
export type NativeBackgroundPage = {
  kind: 'background.page';
  viewGeneration: number;
  storeId: string;
  readId: string;
  observationId: number;
  rootSessionId?: string;
  viewSelection?: number;
  startIndex: number;
  nextIndex: number;
  total: number;
  complete: boolean;
  entries: BackgroundExecutionItem[];
};
export type NativeBackgroundChild = {
  /** Verified conversation presentation, separate from the exact carrier's control observations. */
  presentation?: {
    unavailable?: true;
    runs: NativeRunFact[];
    tools: NativeToolMessageFact[];
    /** Original live Shell inputs only; never Tool receipts or control authority. */
    liveTools?: NativeToolMessageFact[];
    /** Scoped tool facts and top-level Model phases consumed by the shared transcript. */
    executions: NativeToolExecution[];
    fileTargets?: NativeFileChange[];
    textHandles?: { messageId: string; handle: string }[];
    imageHandles?: { messageId: string; handle: string }[];
    compressionProgress?: SessionView['compressionProgress'];
  };
  control?: {
    runs: Pick<
      Run,
      | 'id'
      | 'sessionId'
      | 'originStoreId'
      | 'originCommandId'
      | 'carrierExecutionId'
      | 'rootWorkCommandId'
      | 'rootWorkSeq'
      | 'isActive'
    >[];
    executions: Pick<
      Execution,
      | 'id'
      | 'sessionId'
      | 'originStoreId'
      | 'runId'
      | 'rootWorkCommandId'
      | 'rootWorkSeq'
      | 'authorization'
      | 'status'
      | 'cancelRequestedAt'
    >[];
  };
  item: BackgroundExecutionItem;
  session: Session;
  upperSeq: string;
  /** Present only for the incremental environment consumer; earlier rows remain verified. */
  afterSeq?: string;
  messages: Message[];
  modelOutputs: { messageId: string; snapshot: ModelOutputSnapshot }[];
};
export type NativeBackgroundChildOpen = {
  kind: 'background.child.opened';
  viewGeneration: number;
  storeId: string;
  readId: string;
  observationId: number;
  rootSessionId?: string;
  viewSelection?: number;
  executionId: string;
  childSessionId: string;
  childRunId: string | null;
  wireBytes: string;
  wireHash: string;
};
export type NativeBackgroundChildChunk = {
  kind: 'background.child.chunk';
  readId: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
};
export type NativeBackgroundResult =
  | NativeBackgroundPage
  | NativeJobOutputPage
  | NativeBackgroundChildOpen
  | NativeBackgroundChildChunk;
