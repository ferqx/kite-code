// src/core/session-logger/index.ts

export {
  ActiveSessionLease,
  type ActiveSessionLeaseOptions,
  inspectSessionLogLease,
  readProcessStartIdentity,
  SESSION_LOG_ADMISSION_LOCK_FILE,
  SESSION_LOG_LEASE_FILE,
  SESSION_LOG_LEASE_RESERVE_BYTES,
  SESSION_LOG_OPERATION_RESERVE_BYTES,
  SESSION_LOG_TERMINAL_FILE,
  type SessionLogLeaseInspection,
  type SessionLogLeaseRecordV1,
  tryAcquireSessionLogAdmission,
  tryAcquireSessionOperation,
} from './active-session-lease';
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
export {
  runSessionLogMaintenance,
  type SessionLogMaintenanceOptions,
  type SessionLogMaintenanceReport,
} from './retention';
export {
  assertSafeSessionLogSegment,
  assertSecureOpenFileIdentity,
  assertSecureSessionLogDirectoryChainIdentity,
  captureSecureSessionLogDirectoryChain,
  ensureSecureSessionLogDirectory,
  ensureSecureSessionLogDirectoryChain,
  openSecureAppendFile,
  type SecureSessionLogDirectoryBinding,
  type SecureSessionStorageOptions,
  secureWindowsOwnerOnlyPath,
  unlinkSecureFileIfIdentity,
  writeSessionLogJsonAtomically,
} from './secure-storage';
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
export { SessionLogWriter, type SessionLogWriterOptions } from './writer';
