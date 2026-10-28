export type NativeInputQueueScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
};
export type NativeInputQueueRequest =
  | {
      method: 'input.queue.read';
      generation: number;
      readId: string;
      viewSelection: number;
      historyEpoch: number;
    }
  | { method: 'input.queue.close'; generation: number; readId: string }
  | {
      method: 'input.queue.steer';
      generation: number;
      observationId: number;
      targetCommandId: string;
    }
  | {
      method: 'input.queue.withdraw';
      generation: number;
      observationId: number;
      targetCommandId: string;
      purpose: 'edit' | 'delete';
    }
  | {
      method: 'input.queue.reorder';
      generation: number;
      observationId: number;
      commandIds: readonly string[];
    }
  | { method: 'input.queue.lookup' | 'input.queue.ack'; generation: number; commandId: string };
export type NativeInputQueueSubmission = {
  kind: 'input.queue.submission';
  scope: Pick<NativeInputQueueScope, 'storeId' | 'sessionId' | 'workspaceId'>;
  commandId: string;
  operation: 'edit' | 'delete' | 'reorder';
  targetCommandId?: string;
  phase: 'submitting' | 'unknown' | 'applied' | 'rejected';
  /** Only a verified withdrawn text-only edit returns the Main-owned original text. */
  text?: string;
  error?: string;
};
export type NativeInputQueueObservation = {
  kind: 'input.queue.observation';
  scope: NativeInputQueueScope;
  readId: string;
  observationId: number;
  revision: string;
  entries: { id: string; text: string; editable: boolean; steerable?: boolean }[];
  submissions: NativeInputQueueSubmission[];
};
export type NativeInputQueueResult = NativeInputQueueObservation | NativeInputQueueSubmission;
