// apps/kite-service/src/session-logger/index.ts

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
} from '@kite-ai/builtin-runtime/model';
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
  type SessionLogLeaseRecord,
  tryAcquireSessionLogAdmission,
  tryAcquireSessionOperation,
} from './active-session-lease';
export { SessionLogCollector, type SessionLogCollectorOptions } from './collector';
export {
  mapRuntimeMetadata,
  mapSessionBoundaryMetadata,
  metadataToolKind,
} from './metadata-mapper';
export { recordContentRuntimeEvent } from './recorder';
export {
  runSessionLogMaintenance,
  type SessionLogMaintenanceOptions,
  type SessionLogMaintenanceReport,
} from './retention';
export type {
  MetadataEventRecord,
  MetadataFields,
  SessionLoggingContentInspection,
  SessionLoggingContentInspector,
  SessionLoggingContentProvenance,
  SessionLoggingDiagnostic,
  SessionMetadataContext,
  TraceEvent,
  TraceRecord,
} from './types';
export { SessionLogWriter, type SessionLogWriterOptions } from './writer';
