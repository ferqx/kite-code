// src/core/session-logger/index.ts

export { classifyToolFailure, ToolFailureReason } from './classifier';
export { SessionLogCollector, type SessionLogCollectorOptions } from './collector';
export {
  createRuntimeSecretDetectorV1,
  type RuntimeSecretDetectorOptionsV1,
} from './content-inspector';
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
  SessionLoggingContentInspectionV1,
  SessionLoggingContentInspectorV1,
  SessionLoggingContentProvenanceV1,
  SessionLoggingDiagnosticV1,
  SessionMetadataContextV1,
  TraceEvent,
  TraceRecord,
} from './types';
export { SessionLogWriter } from './writer';
