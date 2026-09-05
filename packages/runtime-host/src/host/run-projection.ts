import { createHash } from 'node:crypto';
import type {
  RuntimeCommandReceipt,
  RuntimeRunPhase,
  RuntimeRunProjection,
  RuntimeRunStatus,
} from '@kite-ai/runtime-contract';
import {
  assertRuntimeStoredCommandResourceResult,
  assertRuntimeStoredRun,
  RUNTIME_RUN_PHASES,
  RUNTIME_RUN_STATUSES,
  type RuntimeStoredCommandResourceResult,
  type RuntimeStoredRun,
} from '../storage';

export function projectRuntimeStoredRun(
  run: RuntimeStoredRun,
  options: { readonly recoveryRequired?: boolean } = {},
): RuntimeRunProjection {
  assertRuntimeStoredRun(run);
  if (options.recoveryRequired && isNonterminal(run.status)) {
    // This is a read-only restart projection, not a persisted lifecycle
    // transition. Reuse the last durable Run clock value so GET cannot invent
    // a wall-clock fact or mutate/recover the Session merely to render it.
    const recoveryBoundaryMs = run.startedAtMs ?? run.createdAtMs;
    return Object.freeze({
      schema: 'kite.runtime-run.v1',
      sessionId: run.sessionId,
      runId: run.runId,
      ...(run.originSessionId === undefined ? {} : { originSessionId: run.originSessionId }),
      ...(run.originRunId === undefined ? {} : { originRunId: run.originRunId }),
      phase: run.phase,
      status: 'unknown',
      createdRevision: run.createdRevision,
      lastRevision: run.lastRevision,
      createdAtMs: run.createdAtMs,
      startedAtMs: recoveryBoundaryMs,
      finishedAtMs: recoveryBoundaryMs,
      terminal: Object.freeze({
        reasonCode: 'recovery_required',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      }),
    });
  }
  return Object.freeze({
    schema: 'kite.runtime-run.v1',
    sessionId: run.sessionId,
    runId: run.runId,
    ...(run.originSessionId === undefined ? {} : { originSessionId: run.originSessionId }),
    ...(run.originRunId === undefined ? {} : { originRunId: run.originRunId }),
    phase: run.phase,
    status: run.status,
    createdRevision: run.createdRevision,
    lastRevision: run.lastRevision,
    createdAtMs: run.createdAtMs,
    ...(run.startedAtMs === undefined ? {} : { startedAtMs: run.startedAtMs }),
    ...(run.finishedAtMs === undefined ? {} : { finishedAtMs: run.finishedAtMs }),
    ...(run.terminal === undefined ? {} : { terminal: Object.freeze({ ...run.terminal }) }),
  });
}

function isNonterminal(status: RuntimeRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}

export function parseRuntimeStoredCommandResource(
  result: RuntimeStoredCommandResourceResult | undefined,
  commandId?: string,
): Extract<RuntimeCommandReceipt, { status: 'applied' | 'idempotent_replay' }>['resource'] {
  if (result === undefined) return undefined;
  assertRuntimeStoredCommandResourceResult(result);
  if (result.schema !== 'kite.runtime.run-resource-result.v1') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.json);
  } catch {
    throw new Error('Runtime Run resource result JSON is malformed.');
  }
  const record = plainRecord(parsed);
  const runRecord = plainRecord(record.run);
  if (record.schema !== result.schema || runRecord.schema !== 'kite.runtime-run.v1') {
    throw new Error('Runtime Run resource result schema is invalid.');
  }
  const phase = runPhase(runRecord.phase);
  const status = runStatus(runRecord.status);
  const stored: RuntimeStoredRun = {
    sessionId: stringField(runRecord.sessionId),
    runId: stringField(runRecord.runId),
    startCommandId: 'resource-projection-validation',
    ...(runRecord.originSessionId === undefined
      ? {}
      : { originSessionId: stringField(runRecord.originSessionId) }),
    ...(runRecord.originRunId === undefined
      ? {}
      : { originRunId: stringField(runRecord.originRunId) }),
    phase,
    status,
    createdRevision: integerField(runRecord.createdRevision),
    lastRevision: integerField(runRecord.lastRevision),
    createdAtMs: integerField(runRecord.createdAtMs),
    ...(runRecord.startedAtMs === undefined
      ? {}
      : { startedAtMs: integerField(runRecord.startedAtMs) }),
    ...(runRecord.finishedAtMs === undefined
      ? {}
      : { finishedAtMs: integerField(runRecord.finishedAtMs) }),
    ...(runRecord.terminal === undefined ? {} : { terminal: terminalField(runRecord.terminal) }),
  };
  assertRuntimeStoredRun(stored);
  const run = projectRuntimeStoredRun(stored);
  const canonical = JSON.stringify({ schema: result.schema, run });
  if (canonical !== result.json) {
    throw new Error('Runtime Run resource result is not the closed canonical projection.');
  }
  if (!commandId) throw new Error('Runtime Run resource projection requires command identity.');
  return Object.freeze({ kind: 'run', run, messageId: runtimeStartMessageId(commandId) });
}

export function runtimeStartMessageId(commandId: string): string {
  if (typeof commandId !== 'string' || commandId.length === 0 || commandId.includes('\0')) {
    throw new Error('Runtime start command identity is invalid.');
  }
  const digest = createHash('sha256')
    .update(`kite.runtime.start-turn.v1\0message\0${commandId}`)
    .digest('hex');
  return `message_${digest.slice(0, 32)}`;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Runtime Run resource result shape is invalid.');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Runtime Run resource text is invalid.');
  return value;
}

function integerField(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Runtime Run resource integer is invalid.');
  }
  return value as number;
}

function runPhase(value: unknown): RuntimeRunPhase {
  if (!RUNTIME_RUN_PHASES.includes(value as RuntimeRunPhase)) {
    throw new Error('Runtime Run resource phase is invalid.');
  }
  return value as RuntimeRunPhase;
}

function runStatus(value: unknown): RuntimeRunStatus {
  if (!RUNTIME_RUN_STATUSES.includes(value as RuntimeRunStatus)) {
    throw new Error('Runtime Run resource status is invalid.');
  }
  return value as RuntimeRunStatus;
}

function terminalField(value: unknown): NonNullable<RuntimeStoredRun['terminal']> {
  const terminal = plainRecord(value);
  const recoveryEntry = terminal.recoveryEntry;
  if (
    recoveryEntry !== 'none' &&
    recoveryEntry !== 'retry' &&
    recoveryEntry !== 'reconcile' &&
    recoveryEntry !== 'new_run' &&
    recoveryEntry !== 'operator_action'
  ) {
    throw new Error('Runtime Run resource recovery entry is invalid.');
  }
  if (typeof terminal.safeRetry !== 'boolean') {
    throw new Error('Runtime Run resource safe-retry flag is invalid.');
  }
  return {
    reasonCode: stringField(terminal.reasonCode),
    safeRetry: terminal.safeRetry,
    recoveryEntry,
    ...(terminal.outcomeId === undefined ? {} : { outcomeId: stringField(terminal.outcomeId) }),
  };
}
