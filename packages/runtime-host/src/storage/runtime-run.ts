import { createHash } from 'node:crypto';

export const RUNTIME_RUN_PHASES = ['planning', 'building'] as const;
export type RuntimeRunPhase = (typeof RUNTIME_RUN_PHASES)[number];

export const RUNTIME_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const;
export type RuntimeRunStatus = (typeof RUNTIME_RUN_STATUSES)[number];

export const RUNTIME_RUN_RECOVERY_ENTRIES = [
  'none',
  'retry',
  'reconcile',
  'new_run',
  'operator_action',
] as const;
export type RuntimeRunRecoveryEntry = (typeof RUNTIME_RUN_RECOVERY_ENTRIES)[number];

export interface RuntimeRunTerminal {
  readonly reasonCode: string;
  readonly safeRetry: boolean;
  readonly recoveryEntry: RuntimeRunRecoveryEntry;
  readonly outcomeId?: string;
}

export interface RuntimeStoredRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly originSessionId?: string;
  readonly originRunId?: string;
  readonly startCommandId: string;
  readonly phase: RuntimeRunPhase;
  readonly status: RuntimeRunStatus;
  readonly createdRevision: number;
  readonly lastRevision: number;
  readonly createdAtMs: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly terminal?: RuntimeRunTerminal;
}

export interface RuntimeRunPageCursor {
  readonly createdRevision: number;
  readonly runId: string;
}

export interface RuntimeRunPageRequest {
  readonly sessionId: string;
  readonly status?: RuntimeRunStatus;
  readonly phase?: RuntimeRunPhase;
  readonly cursor?: RuntimeRunPageCursor;
  readonly limit: number;
}

export interface RuntimeRunPage {
  readonly entries: readonly RuntimeStoredRun[];
  readonly nextCursor?: RuntimeRunPageCursor;
  readonly hasMore: boolean;
}

export interface RuntimeRunTransition {
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedLastRevision: number;
  readonly next: RuntimeStoredRun;
}

export type RuntimeRunRewindResult =
  | { readonly status: 'applied'; readonly deletedCount: number }
  | { readonly status: 'invalid_boundary' };

export interface RuntimeRunForkInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly throughRevision: number;
}

export type RuntimeRunForkResult =
  | { readonly status: 'applied'; readonly copiedCount: number }
  | { readonly status: 'invalid_boundary' };

export type RuntimeRunTransactionMutation =
  | { readonly type: 'insert'; readonly run: RuntimeStoredRun }
  | { readonly type: 'transition'; readonly transition: RuntimeRunTransition };

/** Neutral Store mechanism. The Host remains transaction/lifecycle authority. */
export interface RuntimeRunStorePort {
  get(sessionId: string, runId: string): RuntimeStoredRun | null;
  /** At most one row by the Store 8 active-Run invariant. */
  getActive(sessionId: string): RuntimeStoredRun | null;
  list(request: RuntimeRunPageRequest): RuntimeRunPage;
  insert(run: RuntimeStoredRun): void;
  transition(input: RuntimeRunTransition): 'applied' | 'conflict' | 'missing';
  /** Same-transaction checkpoint maintenance; the concrete Store owns BEGIN/COMMIT. */
  rewindSession(sessionId: string, targetRevision: number): RuntimeRunRewindResult;
  /** Copy only complete, settled history and preserve the source coverage boundary. */
  forkSession(input: RuntimeRunForkInput): RuntimeRunForkResult;
}

export interface RuntimeStoredCommandResourceResult {
  readonly schema: string;
  readonly json: string;
  readonly digest: string;
}

export const RUNTIME_RUN_RESOURCE_RESULT_SCHEMA_ = 'kite.runtime.run-resource-result.v1' as const;

const TERMINAL_STATUSES = new Set<RuntimeRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);
const REQUIRED_TERMINAL_DETAIL = new Set<RuntimeRunStatus>(['failed', 'cancelled', 'unknown']);
const MAX_RESULT_BYTES = 1_048_576;

export function assertRuntimeStoredRun(run: RuntimeStoredRun): void {
  assertRunText(run.sessionId, 'Session identity');
  assertRunText(run.runId, 'Run identity');
  assertRunText(run.startCommandId, 'start command identity');
  if ((run.originSessionId === undefined) !== (run.originRunId === undefined)) {
    throw new Error('Runtime Run origin identity must be complete or absent.');
  }
  if (run.originSessionId !== undefined) assertRunText(run.originSessionId, 'origin Session');
  if (run.originRunId !== undefined) assertRunText(run.originRunId, 'origin Run');
  if (!RUNTIME_RUN_PHASES.includes(run.phase)) throw new Error('Runtime Run phase is invalid.');
  if (!RUNTIME_RUN_STATUSES.includes(run.status)) throw new Error('Runtime Run status is invalid.');
  assertSafeNonNegative(run.createdRevision, 'created revision');
  assertSafeNonNegative(run.lastRevision, 'last revision');
  if (run.lastRevision < run.createdRevision) {
    throw new Error('Runtime Run last revision precedes its created revision.');
  }
  assertSafeNonNegative(run.createdAtMs, 'created time');
  if (run.startedAtMs !== undefined) assertSafeNonNegative(run.startedAtMs, 'started time');
  if (run.finishedAtMs !== undefined) assertSafeNonNegative(run.finishedAtMs, 'finished time');
  const terminal = TERMINAL_STATUSES.has(run.status);
  if (terminal !== (run.finishedAtMs !== undefined)) {
    throw new Error('Runtime Run finished time does not match terminal status.');
  }
  if ((run.status === 'queued') !== (run.startedAtMs === undefined)) {
    throw new Error('Runtime Run started time does not match queued status.');
  }
  if (
    (run.startedAtMs !== undefined && run.startedAtMs < run.createdAtMs) ||
    (run.finishedAtMs !== undefined && run.finishedAtMs < (run.startedAtMs ?? run.createdAtMs))
  ) {
    throw new Error('Runtime Run timestamps are not monotonic.');
  }
  if (!terminal && run.terminal !== undefined) {
    throw new Error('Active Runtime Run cannot carry terminal detail.');
  }
  if (REQUIRED_TERMINAL_DETAIL.has(run.status) && run.terminal === undefined) {
    throw new Error('Non-success terminal Runtime Run requires terminal detail.');
  }
  if (run.terminal !== undefined) assertRuntimeRunTerminal(run.terminal);
}

export function encodeRuntimeRunTerminal(terminal: RuntimeRunTerminal): string {
  assertRuntimeRunTerminal(terminal);
  return JSON.stringify({
    reason_code: terminal.reasonCode,
    safe_retry: terminal.safeRetry,
    recovery_entry: terminal.recoveryEntry,
    ...(terminal.outcomeId === undefined ? {} : { outcome_id: terminal.outcomeId }),
  });
}

export function decodeRuntimeRunTerminal(json: string): RuntimeRunTerminal {
  if (typeof json !== 'string' || utf8Bytes(json) > 4_096) {
    throw new Error('Runtime Run terminal JSON is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Runtime Run terminal JSON is malformed.');
  }
  if (!isPlainRecord(value)) throw new Error('Runtime Run terminal shape is invalid.');
  const keys = Object.keys(value).sort();
  const expected =
    value.outcome_id === undefined
      ? ['reason_code', 'recovery_entry', 'safe_retry']
      : ['outcome_id', 'reason_code', 'recovery_entry', 'safe_retry'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Runtime Run terminal shape is not closed.');
  }
  const terminal: RuntimeRunTerminal = {
    reasonCode: stringValue(value.reason_code),
    safeRetry: booleanValue(value.safe_retry),
    recoveryEntry: recoveryEntry(value.recovery_entry),
    ...(value.outcome_id === undefined ? {} : { outcomeId: stringValue(value.outcome_id) }),
  };
  assertRuntimeRunTerminal(terminal);
  if (encodeRuntimeRunTerminal(terminal) !== json) {
    throw new Error('Runtime Run terminal JSON is not canonical.');
  }
  return Object.freeze(terminal);
}

export function assertRuntimeStoredCommandResourceResult(
  result: RuntimeStoredCommandResourceResult,
): void {
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(result.schema)) {
    throw new Error('Runtime command resource result schema is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(result.digest)) {
    throw new Error('Runtime command resource result digest is invalid.');
  }
  if (typeof result.json !== 'string' || utf8Bytes(result.json) > MAX_RESULT_BYTES) {
    throw new Error('Runtime command resource result JSON is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(result.json);
  } catch {
    throw new Error('Runtime command resource result JSON is malformed.');
  }
  assertSafeJson(value, 0);
  if (JSON.stringify(value) !== result.json) {
    throw new Error('Runtime command resource result JSON is not canonical.');
  }
  if (createHash('sha256').update(result.json).digest('hex') !== result.digest) {
    throw new Error('Runtime command resource result digest does not match its JSON.');
  }
}

/** Original start response derived only from immutable Run creation facts. */
export function createRuntimeRunStartResourceResult(
  run: RuntimeStoredRun,
): RuntimeStoredCommandResourceResult {
  assertRuntimeStoredRun(run);
  const json = JSON.stringify({
    schema: RUNTIME_RUN_RESOURCE_RESULT_SCHEMA_,
    run: {
      schema: 'kite.runtime-run.v1',
      sessionId: run.sessionId,
      runId: run.runId,
      ...(run.originSessionId === undefined ? {} : { originSessionId: run.originSessionId }),
      ...(run.originRunId === undefined ? {} : { originRunId: run.originRunId }),
      phase: run.phase,
      status: 'queued',
      createdRevision: run.createdRevision,
      lastRevision: run.createdRevision,
      createdAtMs: run.createdAtMs,
    },
  });
  return Object.freeze({
    schema: RUNTIME_RUN_RESOURCE_RESULT_SCHEMA_,
    json,
    digest: createHash('sha256').update(json).digest('hex'),
  });
}

export function assertRuntimeRunStartResourceResult(
  result: RuntimeStoredCommandResourceResult,
  run: RuntimeStoredRun,
): void {
  assertRuntimeStoredCommandResourceResult(result);
  const expected = createRuntimeRunStartResourceResult(run);
  if (
    result.schema !== expected.schema ||
    result.json !== expected.json ||
    result.digest !== expected.digest
  ) {
    throw new Error('Runtime Run start resource result does not match its Run creation facts.');
  }
}

function assertRuntimeRunTerminal(terminal: RuntimeRunTerminal): void {
  assertRunText(terminal.reasonCode, 'terminal reason code');
  if (typeof terminal.safeRetry !== 'boolean') {
    throw new Error('Runtime Run terminal safe-retry flag is invalid.');
  }
  if (!RUNTIME_RUN_RECOVERY_ENTRIES.includes(terminal.recoveryEntry)) {
    throw new Error('Runtime Run terminal recovery entry is invalid.');
  }
  if (terminal.outcomeId !== undefined) assertRunText(terminal.outcomeId, 'terminal outcome');
}

function assertRunText(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > 512 ||
    value.includes('\0') ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Runtime Run ${field} is invalid.`);
  }
}

function assertSafeNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime Run ${field} is invalid.`);
  }
}

function assertSafeJson(value: unknown, depth: number): void {
  if (depth > 16) throw new Error('Runtime command resource result JSON is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('Runtime command resource result JSON number is invalid.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error('Runtime command resource result array is too large.');
    for (const item of value) assertSafeJson(item, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) throw new Error('Runtime command resource result JSON is unsafe.');
  const keys = Object.keys(value);
  if (keys.length > 256) throw new Error('Runtime command resource result object is too large.');
  for (const key of keys) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('Runtime command resource result key is forbidden.');
    }
    assertSafeJson(value[key], depth + 1);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Runtime Run terminal text is invalid.');
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Runtime Run terminal boolean is invalid.');
  return value;
}

function recoveryEntry(value: unknown): RuntimeRunRecoveryEntry {
  if (!RUNTIME_RUN_RECOVERY_ENTRIES.includes(value as RuntimeRunRecoveryEntry)) {
    throw new Error('Runtime Run terminal recovery entry is invalid.');
  }
  return value as RuntimeRunRecoveryEntry;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
