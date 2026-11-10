import type * as API from '@kite-ai/client';

/** Main exposes named Trace management operations, with no caller-selected URL or vault reader. */
export type NativeTraceOperation =
  | { kind: 'list' }
  | { kind: 'inspect' | 'delivery'; installationId: string }
  | { kind: 'validate' | 'install'; input: API.TraceInstallRequest }
  | { kind: 'installOpenTelemetry'; input: API.TraceOtelInstallRequest }
  | { kind: 'configure'; installationId: string; input: API.TraceConfigureRequest }
  | { kind: 'grant'; installationId: string; input: API.TraceGrantRequest }
  | { kind: 'update'; installationId: string; input: API.TraceInstallRequest }
  | { kind: 'enable' | 'disable' | 'revoke' | 'uninstall'; installationId: string }
  | { kind: 'history'; installationId: string; input: API.TraceHistoryRequest }
  | {
      kind: 'partition' | 'deadLetters' | 'retry' | 'cancel' | 'pause' | 'resume';
      installationId: string;
      partitionId: string;
    }
  | { kind: 'bindCredential'; installationId: string; input: API.TraceCredentialBind }
  | { kind: 'revokeCredential'; installationId: string; input: API.TraceCredentialRevoke };
export type NativeTraceRequest = {
  method: 'trace.manage';
  generation: number;
  operation: NativeTraceOperation;
};
export type NativeTraceResult =
  | { kind: 'trace.delivery'; value: API.TraceRemoteDeliveryStatus }
  | { kind: 'trace.installations'; value: API.TraceInstallationList }
  | { kind: 'trace.installation'; value: API.TraceInstallation }
  | { kind: 'trace.installed'; value: API.TraceInstallResult }
  | { kind: 'trace.validated'; value: API.TraceBundleValidation }
  | { kind: 'trace.history'; value: API.TraceHistoryResult }
  | { kind: 'trace.partition'; value: API.TracePartitionStatus }
  | { kind: 'trace.deadLetters'; value: API.TraceDeadLetterList }
  | { kind: 'trace.credential'; value: API.TraceCredentialResult }
  | { kind: 'trace.action'; value: API.TraceActionResult };
