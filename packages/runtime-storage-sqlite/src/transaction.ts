import type { Database } from 'bun:sqlite';
import type {
  RuntimeEventMetadata,
  RuntimeSnapshotMetadata,
  RuntimeStorage,
  RuntimeTransactionInput,
} from '@kite/runtime-host/storage';
import {
  SqliteRuntimeEffectLeaseConflictError,
  SqliteRuntimeRevisionConflictError,
} from './preflight';

interface SnapshotBoundaryRow {
  readonly event_position: number;
  readonly state_revision: number;
  readonly state_checksum: string;
  readonly schema_version: number;
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
}): RuntimeStorage<Event, State>['transactions'] {
  const commit = (transaction: RuntimeTransactionInput<Event, State>): void => {
    if (input.isClosed()) return;
    try {
      input.db.transaction(() => {
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
          if (
            !matches ||
            actualPosition !== transaction.expectedRestoreBoundary.lastEventPosition
          ) {
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
        input.insertEvents(transaction.sessionId, transaction.events, transaction.metadata);
        const encoded = input.encodeSnapshot(transaction.snapshot, transaction.snapshotMetadata);
        const position =
          transaction.snapshotMetadata?.eventPosition ??
          input.lastEventPosition(transaction.sessionId);
        input.persistSnapshot(
          transaction.sessionId,
          encoded.json,
          position,
          encoded.metadata.stateRevision,
          encoded.metadata.stateChecksum,
          encoded.metadata.schemaVersion,
        );
      })();
    } catch (error) {
      if (
        error instanceof SqliteRuntimeRevisionConflictError ||
        error instanceof SqliteRuntimeEffectLeaseConflictError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to persist runtime transaction for ${transaction.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  return Object.freeze({
    commitDecision: commit,
    commitAttemptStart: commit,
    commitReceiptEvidence: commit,
    commitTerminalRecovery: commit,
  });
}
