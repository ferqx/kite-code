import { randomUUID } from 'node:crypto';
import type {
  SubagentResultArtifactAccess,
  SubagentResultArtifactRef,
} from '@kite-ai/builtin-runtime/subagent';
import type { RuntimeBackgroundExecutionProjection } from '@kite-ai/runtime-contract';
import type { SubAgentResult } from './types';

const MAX_BACKGROUND_SUBAGENTS = 256;
const MAX_BACKGROUND_REPORT_CHARS = 2_000;

export interface BackgroundSubagentCompletionNotification {
  readonly notificationId: string;
  readonly source: 'subagent';
  readonly modelRole: 'user';
  readonly ownerKey: string;
  readonly taskId: string;
  readonly originRunId: string;
  readonly originTurnId: string;
  readonly originToolCallId: string;
  readonly attempt: number;
  readonly status: BackgroundSubagentStatus;
  readonly shortReport: string;
  readonly resultArtifact: SubagentResultArtifactRef;
  readonly cancelRequested: boolean;
}

export type BackgroundSubagentStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'exhausted'
  | 'suspended'
  | 'unknown';

interface BackgroundSubagentRecord {
  readonly taskId: string;
  readonly displayName?: string;
  readonly ownerKey: string;
  readonly originRunId: string;
  readonly originTurnId: string;
  readonly originToolCallId: string;
  readonly attempt: number;
  readonly cancel: (reason: string) => Promise<void>;
  readonly terminal: Promise<void>;
  status: BackgroundSubagentStatus;
  cancelRequested: boolean;
  cleanupConfirmed: boolean;
  resultArtifact?: SubagentResultArtifactRef;
  settlementConfirmed: boolean;
  terminalError?: string;
  revision: number;
}

export interface BackgroundSubagentAdoption {
  readonly taskId: string;
  readonly displayName?: string;
  readonly ownerKey: string;
  readonly originRunId: string;
  readonly originTurnId: string;
  readonly originToolCallId: string;
  readonly attempt: number;
  /** The Runtime watcher is the only caller permitted to consume Provider.observe. */
  readonly observe: () => Promise<Readonly<SubAgentResult>>;
  readonly cancel: (reason: string) => Promise<void>;
  /** Called only after the immutable result Artifact is readable. */
  readonly onResultPersisted?: (
    notification: Readonly<BackgroundSubagentCompletionNotification>,
  ) => void | Promise<void>;
  /** Releases admission owned outside this Runtime when settlement cannot complete normally. */
  readonly onSettlementFailed?: (error: unknown) => void | Promise<void>;
  readonly settlementRecoveryReservationId?: string;
}

export interface BackgroundSubagentControlRuntime {
  readonly hasLiveTask: (taskId: string) => boolean;
  readonly listSnapshot: (
    sessionId: string,
    ownerKey: string,
  ) => BackgroundSubagentDirectorySnapshot;
  readonly readTask: (
    ownerKey: string,
    taskId: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly requestCancel: (ownerKey: string, taskId: string, onTerminal: () => void) => boolean;
  readonly disposeOwner?: (ownerKey: string, reason?: string, timeoutMs?: number) => Promise<void>;
  readonly settlementRecoveryReservations?: (ownerKey: string) => readonly string[];
  readonly cancelTask: (
    ownerKey: string,
    taskId: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface BackgroundSubagentDirectorySnapshot {
  readonly sessionId: string;
  readonly aggregateGeneration: string;
  readonly watermark: number;
  readonly executions: readonly Omit<RuntimeBackgroundExecutionProjection, 'sessionRevision'>[];
}

/**
 * Execution-host owner for admitted background children.
 *
 * Live Provider handles never leave this owner. One watcher destructively observes each child,
 * persists its immutable terminal report, then exposes repeatable reads through the Artifact.
 */
export class BackgroundSubagentRuntime implements BackgroundSubagentControlRuntime {
  readonly #results: SubagentResultArtifactAccess;
  readonly #records = new Map<string, BackgroundSubagentRecord>();
  readonly #ownerGeneration = `subagent_${randomUUID()}`;
  #watermark = 0;

  constructor(results: SubagentResultArtifactAccess) {
    this.#results = results;
  }

  hasLiveTask(taskId: string): boolean {
    const record = this.#records.get(taskId);
    return record !== undefined && !isTerminal(record.status);
  }

  adopt(input: Readonly<BackgroundSubagentAdoption>): void {
    if (this.#records.has(input.taskId)) {
      throw new Error('Background sub-agent task identity collided.');
    }
    if (
      [...this.#records.values()].filter((record) => !isTerminal(record.status)).length >=
      MAX_BACKGROUND_SUBAGENTS
    ) {
      throw new Error('Background sub-agent owner capacity is exhausted.');
    }
    const record = {
      taskId: input.taskId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ownerKey: input.ownerKey,
      originRunId: input.originRunId,
      originTurnId: input.originTurnId,
      originToolCallId: input.originToolCallId,
      attempt: input.attempt,
      cancel: input.cancel,
      status: 'running' as const,
      cancelRequested: false,
      cleanupConfirmed: false,
      settlementConfirmed: false,
      revision: ++this.#watermark,
    } as BackgroundSubagentRecord;
    const terminal = this.#watch(
      record,
      input.observe,
      input.onResultPersisted,
      input.onSettlementFailed,
      input.settlementRecoveryReservationId,
    );
    Object.defineProperty(record, 'terminal', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: terminal,
    });
    this.#records.set(input.taskId, record);
    void terminal;
  }

  async readTask(ownerKey: string, taskId: string): Promise<Readonly<Record<string, unknown>>> {
    const record = this.#owned(ownerKey, taskId);
    if (!record) {
      const durable = this.#results.lookup(ownerKey, taskId);
      return durable
        ? durableTaskSnapshot(
            taskId,
            durable.ref,
            durable.result,
            this.#hasSettlementProof(ownerKey, taskId, durable.ref),
            true,
          )
        : taskNotFound(taskId);
    }
    return this.#snapshot(record);
  }

  async cancelTask(ownerKey: string, taskId: string): Promise<Readonly<Record<string, unknown>>> {
    const record = this.#owned(ownerKey, taskId);
    if (!record) return taskNotFound(taskId);
    if (!isTerminal(record.status) && !record.cancelRequested) {
      record.cancelRequested = true;
      record.status = 'cancelling';
      record.revision = ++this.#watermark;
      try {
        await record.cancel('task_cancel');
      } catch (error) {
        record.status = 'unknown';
        record.terminalError = boundedError(error);
        record.revision = ++this.#watermark;
        return this.#snapshot(record);
      }
    }
    await record.terminal;
    return this.#snapshot(record);
  }
  requestCancel(ownerKey: string, taskId: string, onTerminal: () => void): boolean {
    const record = this.#owned(ownerKey, taskId);
    if (!record || isTerminal(record.status)) return false;
    if (!record.cancelRequested) {
      record.cancelRequested = true;
      record.status = 'cancelling';
      record.revision = ++this.#watermark;
      void record.cancel('stop_background_execution').catch((error) => {
        record.status = 'unknown';
        record.terminalError = boundedError(error);
        record.revision = ++this.#watermark;
        onTerminal();
      });
    }
    void record.terminal.then(onTerminal, onTerminal);
    return true;
  }

  async #watch(
    record: BackgroundSubagentRecord,
    observe: () => Promise<Readonly<SubAgentResult>>,
    onResultPersisted?: BackgroundSubagentAdoption['onResultPersisted'],
    onSettlementFailed?: BackgroundSubagentAdoption['onSettlementFailed'],
    settlementRecoveryReservationId?: string,
  ): Promise<void> {
    try {
      const result = await observe();
      record.cleanupConfirmed = true;
      const durableResult = jsonRecord(result);
      const artifact = this.#results.write({
        ownerKey: record.ownerKey,
        taskId: record.taskId,
        ...(record.displayName ? { displayName: record.displayName } : {}),
        result: durableResult,
      });
      record.resultArtifact = artifact;
      record.status = terminalStatus(result);
      record.revision = ++this.#watermark;
      if (onResultPersisted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        let callbackSucceeded = false;
        try {
          await onResultPersisted(
            Object.freeze({
              notificationId: `subagent:${record.taskId}:${artifact.integrityIdentifier}`,
              source: 'subagent',
              modelRole: 'user',
              ownerKey: record.ownerKey,
              taskId: record.taskId,
              originRunId: record.originRunId,
              originTurnId: record.originTurnId,
              originToolCallId: record.originToolCallId,
              attempt: record.attempt,
              status: record.status,
              shortReport: shortReport(result),
              resultArtifact: artifact,
              cancelRequested: record.cancelRequested,
            }),
          );
          callbackSucceeded = true;
        } catch (error) {
          record.status = 'unknown';
          record.terminalError = boundedError(error);
          record.revision = ++this.#watermark;
          if (settlementRecoveryReservationId) {
            this.#persistSettlementRecovery(record, artifact, settlementRecoveryReservationId);
          }
          await notifySettlementFailed(onSettlementFailed, error);
        }
        if (callbackSucceeded) {
          try {
            this.#persistSettlementProof(record, artifact);
            record.settlementConfirmed = true;
          } catch (error) {
            // The callback may already have committed an after-turn wake. Do
            // not release its exact replacement reservation on proof failure.
            record.status = 'unknown';
            record.terminalError = boundedError(error);
            record.revision = ++this.#watermark;
          }
        }
      } else {
        this.#persistSettlementProof(record, artifact);
        record.settlementConfirmed = true;
      }
    } catch (error) {
      record.status = 'unknown';
      record.terminalError = boundedError(error);
      record.revision = ++this.#watermark;
      if (settlementRecoveryReservationId && record.resultArtifact) {
        this.#persistSettlementRecovery(
          record,
          record.resultArtifact,
          settlementRecoveryReservationId,
        );
      }
      await notifySettlementFailed(onSettlementFailed, error);
    } finally {
      // Once a durable result and its notification have settled, the Artifact is
      // the terminal authority. Do not retain the live Provider handle as a
      // second in-memory history store.
      if (
        record.resultArtifact &&
        record.settlementConfirmed &&
        this.#results.lookup(record.ownerKey, record.taskId) &&
        this.#records.get(record.taskId) === record
      ) {
        this.#records.delete(record.taskId);
      }
    }
  }

  listSnapshot(sessionId: string, ownerKey: string): BackgroundSubagentDirectorySnapshot {
    const live = [...this.#records.values()]
      .filter((record) => record.ownerKey === ownerKey)
      .map((record) => ({
        executionId: record.taskId,
        ...(record.displayName ? { displayName: record.displayName } : {}),
        sessionId,
        kind: 'subagent' as const,
        status:
          record.status === 'cancelling'
            ? ('stopping' as const)
            : backgroundProjectionStatus(record.status),
        ownerGeneration: this.#ownerGeneration,
        revision: record.revision,
        cleanupConfirmed: record.cleanupConfirmed,
      }));
    const liveIds = new Set(live.map((item) => item.executionId));
    const durable = this.#results
      .list(ownerKey)
      .filter((item) => !isInternalProof(item.result))
      .filter((item) => !liveIds.has(item.taskId))
      .map((item) => ({
        executionId: item.taskId,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        sessionId,
        kind: 'subagent' as const,
        status: this.#hasSettlementProof(ownerKey, item.taskId, item.ref)
          ? durableProjectionStatus(item.result)
          : ('unavailable' as const),
        ownerGeneration: this.#ownerGeneration,
        revision: 0,
        // Result Artifacts are written only after the sole Provider observer
        // returns terminally, so the result itself is the cleanup authority.
        cleanupConfirmed: true,
      }));
    const executions = [...live, ...durable];
    return Object.freeze({
      sessionId,
      aggregateGeneration: this.#ownerGeneration,
      watermark: this.#watermark,
      executions: Object.freeze(executions),
    });
  }

  async disposeOwner(
    ownerKey: string,
    reason = 'runtime_owner_disposed',
    timeoutMs = 10_000,
  ): Promise<void> {
    const records = [...this.#records.values()].filter((record) => record.ownerKey === ownerKey);
    const cancellations: Promise<void>[] = [];
    for (const record of records) {
      if (!record.cleanupConfirmed) {
        record.cancelRequested = true;
        record.status = 'cancelling';
        record.revision = ++this.#watermark;
        cancellations.push(
          Promise.resolve()
            .then(() => record.cancel(reason))
            .catch((error) => {
              record.status = 'unknown';
              record.terminalError = boundedError(error);
              record.revision = ++this.#watermark;
            }),
        );
      }
    }
    await waitBounded(
      Promise.allSettled([...cancellations, ...records.map((record) => record.terminal)]),
      timeoutMs,
    );
    for (const record of records) {
      if (record.cleanupConfirmed && record.settlementConfirmed) {
        this.#records.delete(record.taskId);
      } else if (!record.cleanupConfirmed) {
        record.status = 'unknown';
        record.terminalError = 'Background sub-agent cleanup requires recovery.';
        record.revision = ++this.#watermark;
      }
    }
  }

  #persistSettlementProof(
    record: BackgroundSubagentRecord,
    artifact: SubagentResultArtifactRef,
  ): void {
    this.#results.write({
      ownerKey: record.ownerKey,
      taskId: settlementProofTaskId(artifact),
      result: Object.freeze({
        schema: 'kite.background-subagent-settlement.v1',
        taskId: record.taskId,
        resultIntegrityIdentifier: artifact.integrityIdentifier,
      }),
    });
  }

  #persistSettlementRecovery(
    record: BackgroundSubagentRecord,
    artifact: SubagentResultArtifactRef,
    reservationId: string,
  ): void {
    this.#results.write({
      ownerKey: record.ownerKey,
      taskId: settlementRecoveryTaskId(artifact),
      result: Object.freeze({
        schema: 'kite.background-subagent-settlement-recovery.v1',
        taskId: record.taskId,
        resultIntegrityIdentifier: artifact.integrityIdentifier,
        reservationId,
      }),
    });
  }

  settlementRecoveryReservations(ownerKey: string): readonly string[] {
    return Object.freeze(
      this.#results
        .list(ownerKey)
        .flatMap((item) =>
          item.taskId.startsWith('settlement-recovery-') &&
          item.result.schema === 'kite.background-subagent-settlement-recovery.v1' &&
          typeof item.result.reservationId === 'string'
            ? [item.result.reservationId]
            : [],
        ),
    );
  }

  #hasSettlementProof(
    ownerKey: string,
    taskId: string,
    artifact: SubagentResultArtifactRef,
  ): boolean {
    const proof = this.#results.lookup(ownerKey, settlementProofTaskId(artifact))?.result;
    return (
      proof?.schema === 'kite.background-subagent-settlement.v1' &&
      proof.taskId === taskId &&
      proof.resultIntegrityIdentifier === artifact.integrityIdentifier
    );
  }

  #owned(ownerKey: string, taskId: string): BackgroundSubagentRecord | undefined {
    const record = this.#records.get(taskId);
    return record?.ownerKey === ownerKey ? record : undefined;
  }

  #snapshot(record: BackgroundSubagentRecord): Readonly<Record<string, unknown>> {
    const result = record.resultArtifact
      ? this.#results.read(record.resultArtifact, record.taskId)
      : undefined;
    return Object.freeze({
      ok: record.status !== 'unknown',
      task_id: record.taskId,
      status: record.status,
      cancel_requested: record.cancelRequested,
      cleanup_confirmed: record.cleanupConfirmed,
      ...(record.resultArtifact ? { artifact: record.resultArtifact } : {}),
      ...(result ? { result } : {}),
      ...(record.terminalError ? { error: record.terminalError } : {}),
    });
  }
}

function backgroundProjectionStatus(
  status: BackgroundSubagentStatus,
): 'running' | 'completed' | 'failed' | 'cancelled' | 'unavailable' {
  if (status === 'running' || status === 'cancelling') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled';
  if (status === 'unknown' || status === 'suspended') return 'unavailable';
  return 'failed';
}

export function backgroundSubagentOwnerKey(threadId: string, recoveryIdentityKey: string): string {
  return JSON.stringify([threadId, recoveryIdentityKey]);
}

function taskNotFound(taskId: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ok: false,
    task_id: taskId,
    status: 'not_found',
    cleanup_confirmed: false,
    error: 'Background sub-agent task is unavailable for this Runtime owner.',
  });
}

function durableTaskSnapshot(
  taskId: string,
  ref: SubagentResultArtifactRef,
  result: Readonly<Record<string, unknown>>,
  settlementConfirmed: boolean,
  cleanupConfirmed: boolean,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ok: settlementConfirmed && result.ok !== false,
    task_id: taskId,
    status:
      settlementConfirmed && typeof result.terminalStatus === 'string'
        ? result.terminalStatus
        : 'unknown',
    cancel_requested: false,
    cleanup_confirmed: cleanupConfirmed,
    artifact: ref,
    result,
    ...(settlementConfirmed ? {} : { error: 'Background sub-agent settlement requires recovery.' }),
  });
}

function settlementProofTaskId(ref: SubagentResultArtifactRef): string {
  return `settlement-${ref.integrityIdentifier.replace(/^sha256:/u, '')}`;
}

function settlementRecoveryTaskId(ref: SubagentResultArtifactRef): string {
  return `settlement-recovery-${ref.integrityIdentifier.replace(/^sha256:/u, '')}`;
}

function isInternalProof(result: Readonly<Record<string, unknown>>): boolean {
  return (
    result.schema === 'kite.background-subagent-settlement.v1' ||
    result.schema === 'kite.background-subagent-cleanup.v1' ||
    result.schema === 'kite.background-subagent-settlement-recovery.v1'
  );
}

function durableProjectionStatus(
  result: Readonly<Record<string, unknown>>,
): 'completed' | 'failed' | 'cancelled' | 'unavailable' {
  if (result.terminalStatus === 'completed') return 'completed';
  if (result.terminalStatus === 'cancelled' || result.terminalStatus === 'interrupted')
    return 'cancelled';
  if (result.terminalStatus === 'failed' || result.terminalStatus === 'exhausted') return 'failed';
  return 'unavailable';
}

function terminalStatus(result: Readonly<SubAgentResult>): BackgroundSubagentStatus {
  if (result.terminalStatus) return result.terminalStatus;
  return result.ok ? 'completed' : 'failed';
}

function isTerminal(status: BackgroundSubagentStatus): boolean {
  return status !== 'running' && status !== 'cancelling';
}

function jsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Background sub-agent result is not serializable.');
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Background sub-agent result is not a JSON object.');
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

function boundedError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Background sub-agent outcome is unknown.';
  return message.slice(0, 1_024);
}

async function notifySettlementFailed(
  callback: BackgroundSubagentAdoption['onSettlementFailed'],
  error: unknown,
): Promise<boolean> {
  if (!callback) return true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await callback(error);
      return true;
    } catch {
      // Admission release is idempotent. Retry transient persistence failure;
      // the absent settlement proof remains the durable recovery-required fact.
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return false;
}

async function waitBounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shortReport(result: Readonly<SubAgentResult>): string {
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  return summary.slice(0, MAX_BACKGROUND_REPORT_CHARS) || 'Background sub-agent completed.';
}
