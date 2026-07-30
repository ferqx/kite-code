// src/core/session-logger/index.ts

export { classifyToolFailure, ToolFailureReason } from './classifier';
export { SessionLogCollector } from './collector';
export {
  mapRuntimeMetadataV1,
  mapSessionBoundaryMetadataV1,
  metadataToolKindV1,
} from './metadata-mapper';
export { recordEvent } from './recorder';
export type {
  MetadataEventRecordV1,
  MetadataFieldsV1,
  RunSummary,
  SessionMetadataContextV1,
  TraceEvent,
  TraceRecord,
} from './types';
export { SessionLogWriter } from './writer';
