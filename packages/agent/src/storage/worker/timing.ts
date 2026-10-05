import type { WorkerRequest } from './protocol';
/** Worker-monotonic durations; total excludes host/Worker message transport. */
export interface DbTiming {
  operation: WorkerRequest['method'];
  requestId: number;
  queueWaitMs: number;
  /** Missing for open: file/format/migration work is not fully instrumented. */
  sqlDurationMs?: number;
  /** Actual COMMIT call duration. Missing when no COMMIT was attempted. */
  commitMs?: number;
  totalMs: number;
  outcome: 'succeeded' | 'failed';
}
