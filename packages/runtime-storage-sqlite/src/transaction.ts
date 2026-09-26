import type { Database } from 'bun:sqlite';
import type {
  RuntimeChildSessionIntentMutation,
  RuntimeEventMetadata,
  RuntimeRunStorePort,
  RuntimeSnapshotMetadata,
  RuntimeStorage,
  RuntimeStoredCommandReceipt,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  assertRuntimeRunStartResourceResult,
  CHILD_SESSION_TASK_USER_GOAL,
} from '@kite-ai/runtime-host/storage';
import type {
  SqliteWorkspaceControllerOperationResult,
  SqliteWorkspaceInitialControllerInput,
} from './authority';
import { SqliteWorkspaceAuthorityError } from './authority';
import {
  assertSqliteRuntimeCommandReceipt,
  createSqliteRuntimeCommandReceiptWriter,
  isSqliteRuntimeCommandReceiptConstraint,
  type SqliteRuntimeCommandReceiptWriter,
} from './command-receipts';
import {
  SqliteRuntimeCommandReceiptConflictError,
  SqliteRuntimeCommandReceiptValidationError,
  SqliteRuntimeEffectLeaseConflictError,
  SqliteRuntimeRevisionConflictError,
  type SqliteRuntimeSessionBinding,
} from './preflight';

interface SnapshotBoundaryRow {
  readonly event_position: number;
  readonly state_revision: number;
  readonly state_checksum: string;
  readonly schema_version: number;
}

/**
 * Store 7's only compound create surface.  It is deliberately a storage
 * concern rather than a Runtime wire command: the caller supplies the
 * already-authenticated Controller facts, while this port owns the SQLite
 * transaction and the expected-absent check.
 */
export interface SqliteWorkspaceSessionCreationInput<Event, State> {
  readonly runtime: RuntimeTransactionInput<Event, State>;
  readonly controller: SqliteWorkspaceInitialControllerInput;
  /** Exact parent receipt intent authorizing an internal child Session. */
  readonly childSessionIntent?: RuntimeChildSessionIntentMutation;
  /** Store 9-only Host recovery identity committed with the initial Session. */
  readonly recoveryIdentity?: string;
}

export interface SqliteWorkspaceSessionCreationResult {
  readonly status: 'applied' | 'replay';
  readonly runtimeReceipt: RuntimeStoredCommandReceipt;
  readonly controller: SqliteWorkspaceControllerOperationResult;
}

export interface SqliteWorkspaceSessionCreationPort<Event, State> {
  create(
    input: SqliteWorkspaceSessionCreationInput<Event, State>,
  ): SqliteWorkspaceSessionCreationResult;
}

export interface InitialControllerTransactionPort {
  readonly create: (
    input: SqliteWorkspaceInitialControllerInput,
    mode: 'create' | 'replay',
  ) => SqliteWorkspaceControllerOperationResult;
}

/** The single atomic commit owner for every Runtime storage transaction channel. */
export function createSqliteRuntimeTransactionPort<Event, State>(input: {
  readonly db: Database;
  readonly isClosed: () => boolean;
  readonly hasEffectLease: (
    sessionId: string,
    effectId: string,
    ownerId: string,
    observedAtMs: number,
  ) => boolean;
  readonly readSnapshotBoundary: (sessionId: string) => SnapshotBoundaryRow | null;
  readonly readSnapshotRevision: (sessionId: string) => number | null;
  readonly lastEventPosition: (sessionId: string) => number;
  readonly ensureSession: (sessionId: string, state?: State) => void;
  readonly admitChildSession?: (
    intent: RuntimeChildSessionIntentMutation,
    state: State,
    mode: 'create' | 'replay',
  ) => void;
  readonly insertEvents: (
    sessionId: string,
    events: readonly Event[],
    metadata?: readonly RuntimeEventMetadata[],
  ) => void;
  readonly encodeSnapshot: (
    state: State,
    explicit?: RuntimeSnapshotMetadata,
  ) => { readonly json: string; readonly metadata: RuntimeSnapshotMetadata };
  readonly persistSnapshot: (
    sessionId: string,
    json: string,
    eventPosition: number,
    stateRevision: number,
    stateChecksum: string,
    schemaVersion: number,
  ) => void;
  readonly setSessionModelRoute?: (
    sessionId: string,
    route: import('@kite-ai/runtime-host/storage').RuntimeSessionModelRoute,
  ) => void;
  readonly readSessionBinding?: (sessionId: string) => SqliteRuntimeSessionBinding | null;
  /** Read one Store-owned command receipt while the writer is held. */
  readonly readCommandReceipt?: (
    receipt: RuntimeStoredCommandReceipt,
  ) => RuntimeStoredCommandReceipt | null;
  /** Reject a create target that already has a Runtime row or tombstone. */
  readonly assertSessionAbsent?: (sessionId: string) => void;
  /** Internal Store 7 authority seam; never exposed as a raw DB callback. */
  readonly initialController?: InitialControllerTransactionPort;
  /** Store 9 same-transaction recovery identity primitive. */
  readonly initialRecoveryIdentity?: Readonly<{
    put(sessionId: string, value: string): void;
  }>;
  readonly receiptWriter?: SqliteRuntimeCommandReceiptWriter;
  /** Same-connection Store 8 port. Omit for Store 6/7. */
  readonly runStore?: RuntimeRunStorePort;
  readonly beforeWrite?: () => void;
  readonly afterPersistInTransaction?: (
    channel:
      | 'session_create'
      | 'decision'
      | 'attempt_start'
      | 'receipt_evidence'
      | 'terminal_recovery',
    transaction: RuntimeTransactionInput<Event, State>,
  ) => void;
  /** Only Store13's fenced child owner may authorize a receipt-free internal followup Run. */
  readonly authorizeInternalFollowupRunStart?: (
    transaction: RuntimeTransactionInput<Event, State>,
  ) => void;
  /** Store 9 injects its first-write-aware transaction owner instead of opening a second BEGIN. */
  readonly runWriteTransaction?: <Result>(write: () => Result) => Result;
  /** New Session creation may use the unfenced writer before generation 1 exists. */
  readonly runCreateTransaction?: <Result>(write: () => Result) => Result;
}): RuntimeStorage<Event, State>['transactions'] & {
  readonly createSessionWithInitialController?: SqliteWorkspaceSessionCreationPort<
    Event,
    State
  >['create'];
} {
  const receiptWriter = input.receiptWriter ?? createSqliteRuntimeCommandReceiptWriter(input.db);

  const persist = (
    transaction: RuntimeTransactionInput<Event, State>,
    channel?: 'decision' | 'attempt_start' | 'receipt_evidence' | 'terminal_recovery',
  ): RuntimeSnapshotMetadata => {
    if (
      transaction.requiredEffectLease &&
      !input.hasEffectLease(
        transaction.sessionId,
        transaction.requiredEffectLease.effectId,
        transaction.requiredEffectLease.ownerId,
        transaction.requiredEffectLease.observedAtMs,
      )
    ) {
      throw new SqliteRuntimeEffectLeaseConflictError(
        transaction.sessionId,
        transaction.requiredEffectLease.effectId,
      );
    }
    if (transaction.expectedRestoreBoundary) {
      const actual = input.readSnapshotBoundary(transaction.sessionId);
      const expected = transaction.expectedRestoreBoundary.snapshot;
      const matches = expected
        ? actual != null &&
          actual.event_position === expected.eventPosition &&
          actual.state_revision === expected.stateRevision &&
          actual.state_checksum === expected.stateChecksum &&
          actual.schema_version === expected.schemaVersion
        : actual == null;
      const actualPosition = input.lastEventPosition(transaction.sessionId);
      if (!matches || actualPosition !== transaction.expectedRestoreBoundary.lastEventPosition) {
        throw new SqliteRuntimeRevisionConflictError(
          transaction.sessionId,
          expected?.stateRevision ?? 0,
          actual?.state_revision ?? null,
          `Runtime restore boundary conflict for ${transaction.sessionId}: expected snapshot revision ${expected?.stateRevision ?? 'missing'} at event ${transaction.expectedRestoreBoundary.lastEventPosition}, found snapshot revision ${actual?.state_revision ?? 'missing'} at event ${actualPosition}.`,
        );
      }
    }
    const firstRevision = transaction.metadata?.[0]?.revision;
    if (firstRevision != null) {
      const expectedRevision = firstRevision - 1;
      const actualRevision = input.readSnapshotRevision(transaction.sessionId);
      if (
        (actualRevision == null && expectedRevision !== 0) ||
        (actualRevision != null && actualRevision !== expectedRevision)
      ) {
        throw new SqliteRuntimeRevisionConflictError(
          transaction.sessionId,
          expectedRevision,
          actualRevision,
        );
      }
    }
    input.ensureSession(transaction.sessionId, transaction.snapshot);
    if (transaction.sessionModelRoute) {
      if (!input.setSessionModelRoute)
        throw new Error('Runtime Store cannot persist a Session model route.');
      input.setSessionModelRoute(transaction.sessionId, transaction.sessionModelRoute);
    }
    input.insertEvents(transaction.sessionId, transaction.events, transaction.metadata);
    const encoded = input.encodeSnapshot(transaction.snapshot, transaction.snapshotMetadata);
    const position =
      transaction.snapshotMetadata?.eventPosition ?? input.lastEventPosition(transaction.sessionId);
    input.persistSnapshot(
      transaction.sessionId,
      encoded.json,
      position,
      encoded.metadata.stateRevision,
      encoded.metadata.stateChecksum,
      encoded.metadata.schemaVersion,
    );
    if (transaction.commandReceipt) {
      receiptWriter.insert(
        transaction.commandReceipt,
        transaction.sessionId,
        encoded.metadata.stateRevision,
        input.readSessionBinding?.(transaction.commandReceipt.targetSessionId) ?? undefined,
      );
    }
    if (transaction.runMutation) {
      if (!input.runStore) {
        throw new SqliteRuntimeCommandReceiptValidationError(
          'Runtime Run mutation requires the Store 8 transaction owner.',
        );
      }
      if (transaction.runMutation.type === 'insert') {
        const run = transaction.runMutation.run;
        if (run.originSessionId === undefined) {
          const receipt = transaction.commandReceipt;
          const followup = transaction.followupRunStart;
          const [prepared, configured, task, turn] =
            transaction.events as unknown as readonly Record<string, unknown>[];
          const internalFollowupStart = Boolean(
            channel === 'decision' &&
              followup &&
              !receipt &&
              !transaction.requiredEffectLease &&
              transaction.events.length === 4 &&
              transaction.sessionId === run.sessionId &&
              run.runId === followup.targetRunId &&
              run.startCommandId === `followup:${followup.submissionId}` &&
              run.phase === followup.phase &&
              run.status === 'queued' &&
              run.createdRevision === encoded.metadata.stateRevision &&
              run.lastRevision === run.createdRevision &&
              prepared?.type === 'agent.followup_turn_prepared' &&
              prepared.sourceSessionId === followup.sourceSessionId &&
              prepared.submissionId === followup.submissionId &&
              prepared.targetRunId === followup.targetRunId &&
              prepared.taskId === followup.taskId &&
              prepared.grantDigest === followup.grantDigest &&
              JSON.stringify(prepared.grantRef) === JSON.stringify(followup.grant.ref) &&
              JSON.stringify(prepared.checkpointRef) === JSON.stringify(followup.checkpointRef) &&
              configured?.type === 'resource_budget.configured' &&
              configured.runId === followup.targetRunId &&
              task?.type === 'task.started' &&
              task.taskId === followup.taskId &&
              task.turnId === followup.targetRunId &&
              task.userGoal === CHILD_SESSION_TASK_USER_GOAL &&
              turn?.type === 'turn.started' &&
              turn.turnId === followup.targetRunId,
          );
          if (!internalFollowupStart) {
            if (
              !receipt?.resourceResult ||
              receipt.scopeSessionId !== run.sessionId ||
              receipt.commandId !== run.startCommandId ||
              receipt.targetSessionId !== run.sessionId ||
              receipt.committedRevision !== run.createdRevision
            ) {
              throw new SqliteRuntimeCommandReceiptValidationError(
                'Runtime Run insert requires its exact Store 8 start resource receipt.',
              );
            }
            try {
              assertRuntimeRunStartResourceResult(receipt.resourceResult, run);
            } catch (error) {
              throw new SqliteRuntimeCommandReceiptValidationError(
                `Runtime Run start resource receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else {
            if (!input.authorizeInternalFollowupRunStart) {
              throw new SqliteRuntimeCommandReceiptValidationError(
                'Runtime internal followup Run has no Store13 owner authority.',
              );
            }
            input.authorizeInternalFollowupRunStart(transaction);
          }
        }
        input.runStore.insert(run);
      } else {
        const result = input.runStore.transition(transaction.runMutation.transition);
        if (result !== 'applied') {
          throw new Error(`Runtime Run transition was not applied: ${result}.`);
        }
      }
    }
    return encoded.metadata;
  };

  const inTransaction = <T>(work: () => T): T => {
    if (input.runWriteTransaction) return input.runWriteTransaction(work);
    input.db.run('BEGIN IMMEDIATE');
    try {
      const result = work();
      input.db.run('COMMIT');
      return result;
    } catch (error) {
      try {
        input.db.run('ROLLBACK');
      } catch {
        /* SQLite may have rolled back after a constraint failure. */
      }
      throw error;
    }
  };
  const createInTransaction = <T>(work: () => T): T => {
    if (input.runCreateTransaction) return input.runCreateTransaction(work);
    return inTransaction(work);
  };

  const commit = (
    channel: 'decision' | 'attempt_start' | 'receipt_evidence' | 'terminal_recovery',
    transaction: RuntimeTransactionInput<Event, State>,
  ): void => {
    if (input.isClosed()) return;
    try {
      input.beforeWrite?.();
      // Receipt-bearing commits reserve the writer before inspecting and
      // persisting the decision, so a duplicate scoped key rolls back all
      // event/session metadata and snapshot writes as one unit.
      inTransaction(() => {
        persist(transaction, channel);
        input.afterPersistInTransaction?.(channel, transaction);
      });
    } catch (error) {
      throwRuntimeTransactionError(error, transaction);
    }
  };

  const createSessionWithInitialController =
    input.initialController && input.readCommandReceipt && input.assertSessionAbsent
      ? (
          creation: SqliteWorkspaceSessionCreationInput<Event, State>,
        ): SqliteWorkspaceSessionCreationResult => {
          if (input.isClosed()) {
            throw new Error('SQLite Runtime storage is closed.');
          }
          const runtime = creation.runtime;
          const commandReceipt = runtime.commandReceipt;
          if (!commandReceipt) {
            throw new SqliteRuntimeCommandReceiptValidationError(
              'Initial Controller creation requires a Runtime command receipt.',
            );
          }
          if (runtime.sessionId !== commandReceipt.targetSessionId) {
            throw new SqliteRuntimeCommandReceiptValidationError(
              'Initial Controller creation target does not match the Runtime session.',
            );
          }
          if (creation.controller.sessionId !== runtime.sessionId) {
            throw new SqliteRuntimeCommandReceiptValidationError(
              'Initial Controller creation target does not match the Controller session.',
            );
          }
          assertSqliteRuntimeCommandReceipt(commandReceipt, runtime.sessionId);
          if (
            input.admitChildSession &&
            runtime.sessionId.startsWith('child_') &&
            !creation.childSessionIntent
          )
            throw new SqliteRuntimeCommandReceiptValidationError(
              'Child Session creation requires its exact parent intent.',
            );
          if (
            creation.childSessionIntent &&
            (creation.childSessionIntent.childThreadId !== runtime.sessionId ||
              !input.admitChildSession)
          )
            throw new SqliteRuntimeCommandReceiptValidationError(
              'Child Session creation requires its exact Store parent intent.',
            );
          const persistRecoveryIdentity = (): void => {
            if (!input.initialRecoveryIdentity) {
              if (creation.recoveryIdentity !== undefined) {
                throw new SqliteRuntimeCommandReceiptValidationError(
                  'Initial recovery identity is unsupported by this Store profile.',
                );
              }
              return;
            }
            if (!creation.recoveryIdentity) {
              throw new SqliteRuntimeCommandReceiptValidationError(
                'Initial recovery identity is required by this Store profile.',
              );
            }
            input.initialRecoveryIdentity.put(runtime.sessionId, creation.recoveryIdentity);
          };
          try {
            input.beforeWrite?.();
            return createInTransaction(() => {
              const existing = input.readCommandReceipt!(commandReceipt);
              if (existing) {
                assertSameCommandReceipt(existing, commandReceipt);
                if (creation.childSessionIntent)
                  input.admitChildSession!(creation.childSessionIntent, runtime.snapshot, 'replay');
                persistRecoveryIdentity();
                const controller = input.initialController!.create(creation.controller, 'replay');
                if (controller.status === 'rejected') {
                  throw new SqliteRuntimeCommandReceiptValidationError(
                    'Initial Controller replay has a rejected durable receipt.',
                  );
                }
                return {
                  status: 'replay',
                  runtimeReceipt: existing,
                  controller,
                };
              }
              input.assertSessionAbsent!(runtime.sessionId);
              if (creation.childSessionIntent)
                input.admitChildSession!(creation.childSessionIntent, runtime.snapshot, 'create');
              const metadata = persist(runtime);
              input.afterPersistInTransaction?.('session_create', runtime);
              persistRecoveryIdentity();
              const controller = input.initialController!.create(creation.controller, 'create');
              if (controller.status === 'rejected') {
                throw new SqliteRuntimeCommandReceiptValidationError(
                  'Initial Controller creation was rejected after Runtime writes.',
                );
              }
              return {
                status: 'applied',
                runtimeReceipt: {
                  ...commandReceipt,
                  committedRevision: metadata.stateRevision,
                },
                controller,
              };
            });
          } catch (error) {
            throwRuntimeTransactionError(error, runtime);
          }
        }
      : undefined;

  return Object.freeze({
    commitDecision: (transaction: RuntimeTransactionInput<Event, State>) =>
      commit('decision', transaction),
    commitAttemptStart: (transaction: RuntimeTransactionInput<Event, State>) =>
      commit('attempt_start', transaction),
    commitReceiptEvidence: (transaction: RuntimeTransactionInput<Event, State>) =>
      commit('receipt_evidence', transaction),
    commitTerminalRecovery: (transaction: RuntimeTransactionInput<Event, State>) =>
      commit('terminal_recovery', transaction),
    ...(createSessionWithInitialController ? { createSessionWithInitialController } : {}),
  });
}

function assertSameCommandReceipt(
  actual: RuntimeStoredCommandReceipt,
  expected: RuntimeStoredCommandReceipt,
): void {
  if (
    actual.scopeSessionId !== expected.scopeSessionId ||
    actual.commandId !== expected.commandId ||
    actual.requestDigest !== expected.requestDigest ||
    actual.targetSessionId !== expected.targetSessionId ||
    actual.originalReceiptJson !== expected.originalReceiptJson ||
    actual.committedRevision !== expected.committedRevision ||
    actual.committedAt !== expected.committedAt ||
    actual.resourceResult?.schema !== expected.resourceResult?.schema ||
    actual.resourceResult?.json !== expected.resourceResult?.json ||
    actual.resourceResult?.digest !== expected.resourceResult?.digest
  ) {
    throw new SqliteRuntimeCommandReceiptConflictError(expected.scopeSessionId, expected.commandId);
  }
}

function throwRuntimeTransactionError<Event, State>(
  error: unknown,
  transaction: RuntimeTransactionInput<Event, State>,
): never {
  if (
    error instanceof SqliteRuntimeRevisionConflictError ||
    error instanceof SqliteRuntimeEffectLeaseConflictError ||
    error instanceof SqliteRuntimeCommandReceiptValidationError ||
    error instanceof SqliteRuntimeCommandReceiptConflictError ||
    error instanceof SqliteWorkspaceAuthorityError
  ) {
    throw error;
  }
  if (isSqliteRuntimeCommandReceiptConstraint(error) && transaction.commandReceipt) {
    throw new SqliteRuntimeCommandReceiptConflictError(
      transaction.commandReceipt.scopeSessionId,
      transaction.commandReceipt.commandId,
      error,
    );
  }
  throw new Error(
    `Failed to persist runtime transaction for ${transaction.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
