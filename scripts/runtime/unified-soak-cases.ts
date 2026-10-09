import type { McpStdioJobHandoff } from './unified-soak-mcp-handoff';
import {
  type NativeProcessObservation,
  observeNativeProcess,
  observeProcessListeners,
} from './unified-soak-native';

export interface ResourceObservation {
  metrics: Record<string, number | null>;
  native: NativeProcessObservation;
  listeners: ReturnType<typeof observeProcessListeners>;
}
export function sampleSoakResources(): ResourceObservation {
  const native = observeNativeProcess(),
    listeners = observeProcessListeners();
  return {
    metrics: {
      rssBytes: process.memoryUsage().rss,
      activeResources: null,
      fileDescriptors: native.fileDescriptors,
      listeners: listeners.listeners,
      handles: null,
    },
    native,
    listeners,
  };
}
/** Fixed migrated behavior matrix. No retired cumulative budget ledger. */
export const UNIFIED_SOAK_CASES = Object.freeze([
  'long_runtime_replay',
  'subagent_cancel_recovery',
  'model_transient_stream',
  'mcp_churn',
  'runtime_sigkill_recovery',
  'storage_and_logger_faults',
  'tui_lifecycle_churn',
] as const);
export type UnifiedSoakCaseId = (typeof UNIFIED_SOAK_CASES)[number];
export interface AssertionReceipt {
  id: string;
  actual: string | number | boolean;
  expected: string | number | boolean;
  passed: boolean;
}
export interface CaseEvidence {
  caseId: UnifiedSoakCaseId;
  status: 'passed' | 'failed' | 'unavailable';
  pid: number;
  nonce: string;
  durationMs: number;
  workloadDurationMs: number;
  cleanupConfirmed: boolean;
  assertions: AssertionReceipt[];
  unavailable: string[];
  mcpStdioHandoff?: McpStdioJobHandoff;
  identities?: {
    storeId: string;
    sessionId: string;
    runId: string | null;
    executionId: string | null;
    commandId: string | null;
  }[];
  points?: {
    sequence: number;
    before: Record<string, number | null>;
    after: Record<string, number | null>;
    durationMs: number;
    assertions: AssertionReceipt[];
    observations?: { before: ResourceObservation; after: ResourceObservation };
    mcpStdioHandoff?: McpStdioJobHandoff;
    descendants?: {
      role: 'crash' | 'recovery';
      native: NativeProcessObservation;
      exitCode: number;
      reaped: true;
    }[];
    identities?: CaseEvidence['identities'];
  }[];
}
export const REQUIRED_CASE_ASSERTIONS: Readonly<Record<UnifiedSoakCaseId, readonly string[]>> = {
  long_runtime_replay: [
    'replay_exact_cursor',
    'full_output_hash',
    'no_hidden_twelve_step_limit',
    'explicit_slot_wait',
    'cancel_releases_slot',
    'actual_approved_tool',
    'approval_before_io',
    'actual_compression_published',
  ],
  subagent_cancel_recovery: [
    'actual_child_scope',
    'child_cancel_settled',
    'parent_scope_preserved',
  ],
  model_transient_stream: [
    'partial_not_complete',
    'single_attempt_no_hidden_retry',
    'actual_transport_abort',
    'http_429_terminal',
    'http_429_single_attempt',
    'http_503_terminal',
    'http_503_single_attempt',
  ],
  mcp_churn: [
    'actual_catalogue',
    'actual_remote_result',
    'released_scope_rejected',
    'catalogue_drift_rejected',
    'stdio_exit_unknown',
    'stdio_actual_wire',
  ],
  runtime_sigkill_recovery: [
    'original_execution_ids',
    'zero_model_replay',
    'effect_ledger_exact',
    'unknown_retained',
  ],
  storage_and_logger_faults: [
    'actual_writer_lock',
    'actual_sqlite_full',
    'failed_write_no_partial_event',
    'fault_removed_write_succeeds',
  ],
  tui_lifecycle_churn: ['actual_pty', 'actual_input', 'clean_exit', 'focus_open_close'],
};
