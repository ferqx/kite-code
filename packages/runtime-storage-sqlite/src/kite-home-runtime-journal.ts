import type { Database } from 'bun:sqlite';
import type {
  CheckpointPort,
  EffectLeasePort,
  RuntimeCommandReceiptPort,
  RuntimeEventMetadata,
  RuntimeRecoveryIdentityPort,
  RuntimeSessionDeletionInput,
  RuntimeSessionInfo,
  RuntimeSessionModelRoute,
  RuntimeStorage,
  SessionStore,
} from '@kite-ai/runtime-host/storage';
import { createSqliteWorkspaceInitialControllerTransaction } from './authority';
import { assertSqliteRuntimeCommandReceipt } from './command-receipts';
import { createSqliteEffectLeaseStore } from './effect-leases';
import { createSqliteEventStore } from './event-store';
import { removeKiteHomeWorkspaceAuthoritySessionInTransaction } from './kite-home-authority';
import { createKiteHomeCheckpointStore } from './kite-home-checkpoints';
import { createKiteHomeCommandReceiptStore } from './kite-home-command-receipts';
import { createKiteHomeRecoveryIdentityLedger } from './kite-home-recovery-identities';
import { createKiteHomeRuntimeRunStore } from './kite-home-runs';
import { assertKiteHomeStoreSchema, KITE_HOME_STORE_FORMAT_EPOCH } from './kite-home-store';
import {
  createKiteHomeWorkspaceSessionStore,
  type KiteHomeWorkspaceAdmission,
} from './kite-home-workspaces';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';
import {
  SqliteRuntimeRevisionConflictError,
  type SqliteRuntimeSessionBinding,
  type SqliteRuntimeSnapshotCodec,
} from './preflight';
import { createSqliteSnapshotStore } from './snapshot-store';
import type { SqliteWorkspaceSessionCreationPort } from './transaction';
import { createSqliteRuntimeTransactionPort } from './transaction';

export interface KiteHomeWorkspaceRuntimeJournal<Event, State> {
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeStorage<Event, State>['transactions'];
  readonly effects: EffectLeasePort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPort;
  readonly commandReceipts: RuntimeCommandReceiptPort;
  readonly runs: NonNullable<RuntimeStorage<Event, State>['runs']>;
  readonly checkpoints: CheckpointPort<State>;
  readonly workspaceSessionCreation: SqliteWorkspaceSessionCreationPort<Event, State>;
}

/**
 * Store 9's first RuntimeStorage slice: Workspace-scoped Session metadata, event journal, rolling
 * snapshot and retained command receipt all share one connection and first-write transaction.
 * Controller/effect/Run/checkpoint/recovery ports remain separate until their exact Store 9
 * schemas are wired; this function deliberately does not pretend to be a full RuntimeStorage.
 */
export function createKiteHomeWorkspaceRuntimeJournal<Event, State>(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly workspace: KiteHomeWorkspaceAdmission;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly isClosed?: () => boolean;
  readonly now?: () => number;
}): KiteHomeWorkspaceRuntimeJournal<Event, State> {
  assertKiteHomeStoreSchema(input.database);
  const isClosed = input.isClosed ?? (() => false);
  const sessionMetadata = createKiteHomeWorkspaceSessionStore({
    database: input.database,
    writer: input.writer,
    workspace: input.workspace,
    codec: input.codec,
    stateSchemaVersion: input.stateSchemaVersion,
    formatEpoch: input.formatEpoch,
    ...(input.now ? { now: input.now } : {}),
  });
  const eventStore = createSqliteEventStore<Event>({
    db: input.database,
    codec: input.codec,
    stateSchemaVersion: input.stateSchemaVersion,
    isClosed,
  });
  const snapshotStore = createSqliteSnapshotStore<Event, State>({
    db: input.database,
    codec: input.codec,
    stateSchemaVersion: input.stateSchemaVersion,
    formatEpoch: input.formatEpoch,
    isClosed,
    ensureSession: sessionMetadata.ensureInTransaction,
    hasSessionMetadata: sessionMetadata.has,
    lastEventPosition: eventStore.lastEventPosition,
  });
  const receipts = createKiteHomeCommandReceiptStore({
    database: input.database,
    workspace: input.workspace,
    isClosed,
  });
  const recoveryIdentities = createKiteHomeRecoveryIdentityLedger({
    database: input.database,
    writer: input.writer,
    workspaceId: input.workspace.workspaceId,
    sessions: sessionMetadata,
    isClosed,
  });
  const effectLeaseStore = createSqliteEffectLeaseStore(
    input.database,
    isClosed,
    undefined,
    (write) => input.writer.run(write),
  );
  const runs = createKiteHomeRuntimeRunStore({
    database: input.database,
    writer: input.writer,
    workspace: input.workspace,
    stateSchemaVersion: input.stateSchemaVersion,
    formatEpoch: input.formatEpoch,
    isClosed,
  });
  const checkpoints = createKiteHomeCheckpointStore({
    database: input.database,
    writer: input.writer,
    codec: input.codec,
    stateSchemaVersion: input.stateSchemaVersion,
    formatEpoch: input.formatEpoch,
    isClosed,
    sessions: sessionMetadata,
    events: eventStore,
    snapshots: snapshotStore,
    recovery: recoveryIdentities,
    runs,
    receiptWriter: receipts.writer,
    ...(input.now ? { now: input.now } : {}),
  });
  const selectEffectLease = input.database.query<
    { found: number },
    [string, string, string, number]
  >(
    `SELECT 1 AS found FROM runtime_effect_leases
      WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?
      LIMIT 1`,
  );
  const selectTombstone = input.database.query<{ revision: number }, [string]>(
    `SELECT deleted_revision AS revision FROM runtime_session_tombstones
      WHERE session_id = ? LIMIT 1`,
  );

  const assertReadableSession = (sessionId: string): boolean => {
    const binding = sessionMetadata.binding(sessionId);
    return binding !== null;
  };
  const runtimeBinding = (sessionId: string): SqliteRuntimeSessionBinding | null => {
    const binding = sessionMetadata.binding(sessionId);
    return binding
      ? {
          workerScopeId: binding.workspaceId,
          projectId: binding.projectId,
          workspaceDigest: binding.workspaceDigest,
        }
      : null;
  };

  const sessions: SessionStore<Event, State> = Object.freeze({
    appendEvents(
      sessionId: string,
      events: readonly Event[],
      metadata?: readonly RuntimeEventMetadata[],
    ): void {
      if (isClosed() || events.length === 0) return;
      input.writer.run(() => {
        sessionMetadata.ensureInTransaction(sessionId);
        eventStore.insertEvents(sessionId, events, metadata);
      });
    },
    loadEventsStrict: (sessionId: string, since?: number) =>
      assertReadableSession(sessionId) ? eventStore.loadEvents(sessionId, since) : [],
    saveSnapshot(sessionId: string, state: State): void {
      if (!isClosed()) input.writer.run(() => snapshotStore.save(sessionId, state));
    },
    loadSnapshot: <Loaded = State>(sessionId: string): Loaded | null =>
      assertReadableSession(sessionId)
        ? (snapshotStore.loadRecord<Loaded>(sessionId)?.state ?? null)
        : null,
    loadSnapshotRecord: <Loaded = State>(sessionId: string) =>
      assertReadableSession(sessionId) ? snapshotStore.loadRecord<Loaded>(sessionId) : null,
    getLastEventPosition: (sessionId: string) =>
      isClosed() || !assertReadableSession(sessionId) ? 0 : eventStore.lastEventPosition(sessionId),
    listSessions(query = '', limit = 50): RuntimeSessionInfo[] {
      if (isClosed()) return [];
      const needle = query.trim().toLowerCase();
      return sessionMetadata
        .list(needle ? Math.max(limit, 200) : limit)
        .map((row) => {
          let firstText = '';
          try {
            firstText = eventStore.findFirstSessionSummary(row.threadId)?.searchText ?? '';
          } catch {
            // Advisory naming cannot hide an otherwise healthy Session.
          }
          return { row, firstText };
        })
        .filter(
          ({ row, firstText }) =>
            !needle ||
            row.name.toLowerCase().includes(needle) ||
            firstText.toLowerCase().includes(needle),
        )
        .slice(0, limit)
        .map(({ row, firstText }) => ({
          threadId: row.threadId,
          name: row.name || firstText || row.threadId,
          updatedAt: row.updatedAt,
          needsSmartName: !row.name,
        }));
    },
    setSessionName: (sessionId: string, name: string) => sessionMetadata.setName(sessionId, name),
    getSessionModelRoute: (sessionId: string): RuntimeSessionModelRoute | null =>
      sessionMetadata.getModelRoute(sessionId),
    setSessionModelRoute: (sessionId: string, route: RuntimeSessionModelRoute): void =>
      sessionMetadata.setModelRoute(sessionId, route),
    deleteSession(sessionId: string, deletion?: RuntimeSessionDeletionInput): void {
      if (isClosed()) return;
      if (!deletion) {
        input.writer.run(() => {
          recoveryIdentities.removeInTransaction(sessionId);
          removeKiteHomeWorkspaceAuthoritySessionInTransaction({
            database: input.database,
            writer: input.writer,
            workspaceId: input.workspace.workspaceId,
            sessionId,
          });
          sessionMetadata.deleteInTransaction(sessionId);
        });
        return;
      }
      const binding = runtimeBinding(sessionId);
      if (!binding) {
        throw new SqliteRuntimeRevisionConflictError(sessionId, deletion.expectedRevision, null);
      }
      assertSqliteRuntimeCommandReceipt(
        deletion.commandReceipt,
        sessionId,
        deletion.expectedRevision,
        true,
      );
      input.writer.run(() => {
        recoveryIdentities.removeInTransaction(sessionId);
        removeKiteHomeWorkspaceAuthoritySessionInTransaction({
          database: input.database,
          writer: input.writer,
          workspaceId: input.workspace.workspaceId,
          sessionId,
        });
        sessionMetadata.deleteInTransaction(sessionId, deletion.expectedRevision);
        receipts.writer.insert(
          deletion.commandReceipt,
          sessionId,
          deletion.expectedRevision,
          binding,
        );
      });
    },
  });

  const transactions = createSqliteRuntimeTransactionPort({
    db: input.database,
    isClosed,
    hasEffectLease: (sessionId, effectId, ownerId, observedAtMs) =>
      selectEffectLease.get(sessionId, effectId, ownerId, observedAtMs) !== null,
    readSnapshotBoundary: snapshotStore.getRollingRow,
    readSnapshotRevision: snapshotStore.getRevision,
    lastEventPosition: eventStore.lastEventPosition,
    ensureSession: sessionMetadata.ensureInTransaction,
    insertEvents: eventStore.insertEvents,
    encodeSnapshot: snapshotStore.encode,
    persistSnapshot: snapshotStore.persist,
    receiptWriter: receipts.writer,
    readSessionBinding: runtimeBinding,
    readCommandReceipt: receipts.readExact,
    assertSessionAbsent(sessionId: string): void {
      const binding = sessionMetadata.binding(sessionId);
      if (binding) {
        throw new SqliteRuntimeRevisionConflictError(sessionId, 0, binding.revision);
      }
      if (selectTombstone.get(sessionId)) {
        throw new SqliteRuntimeRevisionConflictError(sessionId, 0, null);
      }
    },
    initialController: {
      create: (request, mode) =>
        createSqliteWorkspaceInitialControllerTransaction({
          db: input.database,
          binding: {
            layoutGeneration: KITE_HOME_STORE_FORMAT_EPOCH,
            workerScopeId: input.workspace.workspaceId,
            workspaceIdentityDigest: input.workspace.workspaceIdentityDigest,
          },
          request,
          mode,
          assertConnection: () => assertKiteHomeStoreSchema(input.database),
          ensureSession(sessionId) {
            const row = input.database
              .query<{ workspace_id: string }, [string]>(
                'SELECT workspace_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
              )
              .get(sessionId);
            if (row?.workspace_id !== input.workspace.workspaceId) {
              throw new Error('Kite Home Controller Session belongs to another Workspace.');
            }
          },
          metadataKey: (key) => `workspace_authority/${input.workspace.workspaceId}/${key}`,
          readMetadata(key) {
            const row = input.database
              .query<{ value: string }, [string]>(
                'SELECT value FROM kite_meta WHERE key = ? LIMIT 1',
              )
              .get(key);
            if (!row) return undefined;
            return JSON.parse(row.value) as unknown;
          },
          writeMetadata(key, value) {
            input.database
              .query('INSERT OR REPLACE INTO kite_meta (key, value) VALUES (?, ?)')
              .run(key, JSON.stringify(value));
          },
          ...(input.now ? { nowMs: input.now } : {}),
        }),
    },
    initialRecoveryIdentity: {
      put: (sessionId, value) => recoveryIdentities.putInTransaction(sessionId, value),
    },
    runStore: runs,
    runWriteTransaction: (write) => input.writer.run(write),
  });
  if (!transactions.createSessionWithInitialController) {
    throw new Error('Kite Home atomic Session creation is unavailable.');
  }
  const workspaceSessionCreation = Object.freeze({
    create: transactions.createSessionWithInitialController,
  });

  const assertEffectSession = (sessionId: string): void => {
    if (!sessionMetadata.binding(sessionId)) {
      throw new Error('Runtime effect Session is not admitted to this Workspace.');
    }
  };
  const effects: EffectLeasePort = Object.freeze({
    tryAcquireEffectLease(
      sessionId: string,
      effectId: string,
      ownerId: string,
      expiresAtMs: number,
    ) {
      assertEffectSession(sessionId);
      return effectLeaseStore.port.tryAcquireEffectLease(sessionId, effectId, ownerId, expiresAtMs);
    },
    renewEffectLease(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) {
      assertEffectSession(sessionId);
      return effectLeaseStore.port.renewEffectLease(sessionId, effectId, ownerId, expiresAtMs);
    },
    releaseEffectLease(sessionId: string, effectId: string, ownerId: string) {
      assertEffectSession(sessionId);
      effectLeaseStore.port.releaseEffectLease(sessionId, effectId, ownerId);
    },
  });

  return Object.freeze({
    sessions,
    transactions,
    effects,
    recoveryIdentities: recoveryIdentities.port,
    commandReceipts: receipts.port,
    runs,
    checkpoints,
    workspaceSessionCreation,
  });
}
