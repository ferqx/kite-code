import type { Command, Execution, Json } from '@kite-ai/client';
import type { NativeCallerMetadata } from './native-bridge';

export type NativeExtensionScope = {
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
  contextSelectionId: string;
};
export type NativeExtensionsRequest = { generation: number } & (
  | { method: 'extensions.open'; readId: string; viewSelection: number; historyEpoch: number }
  | {
      method: 'extensions.query';
      readId: string;
      observationId: number;
      extensionId: string;
      queryId: string;
      input: Json;
    }
  | { method: 'extensions.read'; readId: string; offset: number; limit: number }
  | { method: 'extensions.close'; readId: string }
  | { method: 'extensions.release' }
  | {
      method: 'extensions.invoke';
      observationId: number;
      commandId: string;
      extensionId: string;
      actionId: string;
      definitionVersion: string;
      input: Json;
      viewIndex?: number;
      actionIndex?: number;
    }
  | { method: 'extensions.lookup'; commandId: string }
);
export type NativeExtensionHead = {
  kind: 'extensions.head';
  readId: string;
  observationId: number;
  scope: NativeExtensionScope;
  bodyBytes: number;
  sha256: string;
  content: 'catalogue' | 'views';
};
export type NativeExtensionChunk = {
  kind: 'extensions.chunk';
  readId: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
};
export type NativeExtensionSubmission = {
  kind: 'extensions.command';
  metadata: NativeCallerMetadata;
  commandStatus?: Command['status'];
  execution?: Pick<Execution, 'id' | 'status' | 'resultRevision'>;
  outcome: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'rejected';
};
export type NativeExtensionsResult =
  | NativeExtensionHead
  | NativeExtensionChunk
  | NativeExtensionSubmission;
