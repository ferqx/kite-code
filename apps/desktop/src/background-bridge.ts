import type {
  BackgroundExecutionItem,
  Message,
  ModelOutputSnapshot,
  Session,
} from '@kite-ai/client';
import type { NativeJobOutputPage } from './job-output-bridge';

export const nativeBackgroundPageBytes = 524288;
export type NativeBackgroundRequest =
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
      method: 'background.output.open' | 'background.child.open';
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
    };
export type NativeBackgroundPage = {
  kind: 'background.page';
  viewGeneration: number;
  storeId: string;
  readId: string;
  observationId: number;
  startIndex: number;
  nextIndex: number;
  total: number;
  complete: boolean;
  entries: BackgroundExecutionItem[];
};
export type NativeBackgroundChild = {
  item: BackgroundExecutionItem;
  session: Session;
  upperSeq: string;
  messages: Message[];
  modelOutputs: { messageId: string; snapshot: ModelOutputSnapshot }[];
};
export type NativeBackgroundChildOpen = {
  kind: 'background.child.opened';
  viewGeneration: number;
  storeId: string;
  readId: string;
  observationId: number;
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
