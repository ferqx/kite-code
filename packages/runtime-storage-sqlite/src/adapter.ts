import { constants, type Database } from 'bun:sqlite';
import type {
  ArtifactPort,
  CheckpointPort,
  EffectLeasePort,
  RuntimeCommandForkInput,
  RuntimeCommandForkResult,
  RuntimeCommandReceiptPort,
  RuntimeEventMetadata,
  RuntimeFileRestoreMaterial,
  RuntimeLogQueryPort,
  RuntimeRecoveryIdentityPort,
  RuntimeSessionDeletionInput,
  RuntimeSessionInfo,
  RuntimeSessionModelRoute,
  RuntimeStorage,
  RuntimeStoredCommandReceipt,
  SessionStore,
  StoredRuntimeEvent,
} from '@kite-ai/runtime-host/storage';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import { resolveSqliteArtifactStore } from './artifact-store';
import {
  createSqliteWorkspaceAuthority,
  createSqliteWorkspaceInitialControllerTransaction,
  type SqliteWorkspaceAuthority,
} from './authority';
import { createSqliteRecoveryIdentityLedger } from './authority-ledger';
import {
  assertSqliteRuntimeCommandReceipt,
  createSqliteRuntimeCommandReceiptPort,
  createSqliteRuntimeCommandReceiptWriter,
  isSqliteRuntimeCommandReceiptConstraint,
} from './command-receipts';
import { openSqliteRuntimeConnection } from './connection';
import {
  createSqliteWorkspaceDirectoryOutbox,
  type SqliteWorkspaceDirectoryOutbox,
} from './directory-outbox';
import { createSqliteEffectLeaseStore } from './effect-leases';
import { createSqliteEventStore } from './event-store';
import { assertSqliteWorkspaceStoreActive, markSqliteWorkspaceStoreWritten } from './layout';
import { createSqliteRuntimeLogQueryPortFromDatabase_ } from './log-query';
import {
  assertNoFollowDatabasePath,
  assertSqliteRuntimeStorageCanOpen,
  assertSqliteRuntimeStorageTargetCanOpen_,
  assertSqliteRuntimeWorkspaceBinding,
  checksum,
  defaultSqliteRuntimeJournalMode,
  isCanonicalRecoveryIdentity,
  type NamedSnapshotRow,
  type SnapshotRow,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  SqliteRuntimeCommandReceiptConflictError,
  SqliteRuntimeFormatMismatchError,
  SqliteRuntimeRevisionConflictError,
  type SqliteRuntimeSessionBinding,
  type SqliteRuntimeSnapshotCodec,
  type SqliteRuntimeStorageInput,
  SqliteRuntimeStorageOpenError,
} from './preflight';
import { assertSqliteRuntimeRunStoreConnection, createSqliteRuntimeRunStore } from './run-store';
import { initializeSqliteRuntimeSchema } from './schema';
import { createSqliteSessionMetadataStore } from './session-store';
import { createSqliteSnapshotStore } from './snapshot-store';
import { createSqliteWorkspaceTombstoneStore } from './tombstones';
import {
  createSqliteRuntimeTransactionPort,
  type SqliteWorkspaceSessionCreationPort,
} from './transaction';
import {
  createSqliteWorkspaceCheckpointQuery,
  type SqliteWorkspaceCheckpointQuery,
} from './workspace-checkpoint-query';

class SqliteRuntimeStorageAdapter<Event = unknown, State = unknown>
  implements RuntimeStorage<Event, State>
{
  readonly adapterId = 'sqlite';
  readonly stateSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly formatEpoch: string;
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeStorage<Event, State>['transactions'];
  readonly effects: EffectLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly artifacts: ArtifactPort;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPort;
  readonly commandReceipts: RuntimeCommandReceiptPort;
  /** Current Store 7 durable Worker authority facade; absent for Store 6 and unpublished Store 8. */
  readonly workspaceAuthority?: SqliteWorkspaceAuthority;
  /** Current Store 7 atomic Runtime-session + initial Controller create port. */
  readonly workspaceSessionCreation?: SqliteWorkspaceSessionCreationPort<Event, State>;
  /** Store 7-only path-free Session Directory outbox on this same SQLite connection. */
  readonly directoryOutbox?: SqliteWorkspaceDirectoryOutbox;
  /** Store 7-only bounded log reader factory over this same SQLite connection. */
  readonly openWorkspaceLogQuery?: (
    currentEventTypes: readonly string[],
  ) => RuntimeLogQueryPort<Event>;
  /** Store 7-only bounded Checkpoint metadata reader over this same SQLite connection. */
  readonly workspaceCheckpointQuery?: SqliteWorkspaceCheckpointQuery;
  /** Present only for the explicit, unpublished Store 8 target. */
  readonly runs?: RuntimeStorage<Event, State>['runs'];
  readonly #db: Database;
  readonly #codec: SqliteRuntimeSnapshotCodec<Event, State>;
  #closed = false;

  constructor(input: SqliteRuntimeStorageInput<Event, State>) {
    if (!input.databasePath || !input.codec) {
      throw new SqliteRuntimeStorageOpenError(
        'SQLite Runtime storage requires a databasePath and codec.',
      );
    }
    const workspaceBinding = input.workspaceBinding;
    const runStoreTarget = input.targetStore === 'run';
    if (workspaceBinding) assertSqliteRuntimeWorkspaceBinding(workspaceBinding);
    if (runStoreTarget && !workspaceBinding) {
      throw new SqliteRuntimeStorageOpenError(
        'Store 8 target requires an explicit Workspace binding.',
      );
    }
    if (runStoreTarget && input.workspaceLayout) {
      throw new SqliteRuntimeStorageOpenError(
        'Unpublished Store 8 target cannot claim Store 7 active-layout authority.',
      );
    }
    const profile = runStoreTarget
      ? {
          stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          storeSchemaVersion: SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
          formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
          workspaceBinding: workspaceBinding!,
        }
      : workspaceBinding
        ? {
            stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
            formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
            workspaceBinding,
          }
        : {
            stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
            storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
            formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
          };
    this.stateSchemaVersion = profile.stateSchemaVersion;
    this.storeSchemaVersion = profile.storeSchemaVersion;
    this.formatEpoch = profile.formatEpoch;
    this.#codec = input.codec;
    const baseArtifacts = resolveSqliteArtifactStore(input.artifacts);
    assertNoFollowDatabasePath(input.databasePath);
    if (workspaceBinding && !runStoreTarget) {
      if (!input.workspaceLayout) {
        throw new SqliteRuntimeStorageOpenError(
          'Store 7 writer requires active layout authority evidence.',
        );
      }
      assertSqliteWorkspaceStoreActive(input.workspaceLayout, workspaceBinding, input.databasePath);
    }
    const markWorkspaceWritten =
      workspaceBinding && input.workspaceLayout && !runStoreTarget
        ? () =>
            markSqliteWorkspaceStoreWritten(
              input.workspaceLayout!,
              workspaceBinding,
              input.databasePath,
            )
        : undefined;
    if (runStoreTarget) {
      assertSqliteRuntimeStorageTargetCanOpen_(
        input.databasePath,
        input.codec,
        input.sessionId,
        workspaceBinding!,
        {
          formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
          assertConnection: (database) =>
            assertSqliteRuntimeRunStoreConnection(database, workspaceBinding!),
        },
      );
    } else {
      assertSqliteRuntimeStorageCanOpen(
        input.databasePath,
        input.codec,
        input.sessionId,
        workspaceBinding,
      );
    }
    const journalMode = input.options?.journalMode ?? defaultSqliteRuntimeJournalMode();
    const db = openSqliteRuntimeConnection(input.databasePath, journalMode);
    try {
      initializeSqliteRuntimeSchema(db, profile);
      if (input.options?.faultInjectionMaxPageCount != null) {
        const value = input.options.faultInjectionMaxPageCount;
        if (!Number.isInteger(value) || value <= 0)
          throw new SqliteRuntimeStorageOpenError(
            'faultInjectionMaxPageCount must be a positive integer',
          );
        db.run(`PRAGMA max_page_count = ${value}`);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    if (workspaceBinding && !runStoreTarget) {
      this.workspaceAuthority = createSqliteWorkspaceAuthority({
        db,
        binding: workspaceBinding,
        beforeWrite: markWorkspaceWritten,
      });
      this.directoryOutbox = createSqliteWorkspaceDirectoryOutbox({
        db,
        binding: workspaceBinding,
      });
      this.openWorkspaceLogQuery = (currentEventTypes) => {
        if (this.#closed) {
          throw new SqliteRuntimeStorageOpenError('SQLite Runtime storage is closed.');
        }
        return createSqliteRuntimeLogQueryPortFromDatabase_({
          database: db,
          codec: input.codec,
          currentEventTypes,
        });
      };
      this.workspaceCheckpointQuery = createSqliteWorkspaceCheckpointQuery({
        db,
        binding: workspaceBinding,
      });
    }
    const assertStorageOpen = (): void => {
      if (this.#closed)
        throw new SqliteRuntimeStorageOpenError('SQLite Runtime storage is closed.');
    };
    const withImmediateTransaction = <T>(work: () => T): T => {
      assertStorageOpen();
      db.run('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.run('COMMIT');
        return result;
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* The transaction may already have been rolled back by SQLite. */
        }
        throw error;
      }
    };
    const recoveryIdentities = createSqliteRecoveryIdentityLedger(
      db,
      assertStorageOpen,
      withImmediateTransaction,
      markWorkspaceWritten,
    );
    this.recoveryIdentities = recoveryIdentities.port;
    this.commandReceipts = createSqliteRuntimeCommandReceiptPort({
      db,
      isClosed: () => this.#closed,
      workspaceBinding,
      resourceResults: runStoreTarget,
    });
    const commandReceiptWriter = createSqliteRuntimeCommandReceiptWriter({
      db,
      workspaceBinding,
      beforeWrite: markWorkspaceWritten,
      resourceResults: runStoreTarget,
    });
    const runStore = runStoreTarget
      ? createSqliteRuntimeRunStore({
          db,
          workspaceBinding: workspaceBinding!,
          isClosed: () => this.#closed,
          beforeWrite: markWorkspaceWritten,
        })
      : undefined;
    this.runs = runStore;
    this.artifacts = baseArtifacts;
    const eventStore = createSqliteEventStore<Event>({
      db,
      codec: this.#codec,
      stateSchemaVersion: this.stateSchemaVersion,
      isClosed: () => this.#closed,
      beforeWrite: markWorkspaceWritten,
    });
    const {
      insertEvents,
      loadEvents,
      findFirstSessionSummary,
      lastEventPosition: lastEvent,
    } = eventStore;
    const sessionMetadata = createSqliteSessionMetadataStore<State>({
      db,
      codec: this.#codec,
      stateSchemaVersion: this.stateSchemaVersion,
      formatEpoch: this.formatEpoch,
      workspaceBinding,
      beforeWrite: markWorkspaceWritten,
      onDirectoryChange: this.directoryOutbox?.append,
    });
    const ensureSession = sessionMetadata.ensureSession;
    const snapshotStore = createSqliteSnapshotStore<Event, State>({
      db,
      codec: this.#codec,
      stateSchemaVersion: this.stateSchemaVersion,
      formatEpoch: this.formatEpoch,
      isClosed: () => this.#closed,
      ensureSession,
      hasSessionMetadata: sessionMetadata.hasMetadata,
      lastEventPosition: lastEvent,
      beforeWrite: markWorkspaceWritten,
    });
    const {
      encode: encodeSnapshot,
      persist: persistSnapshot,
      validateRestore: restoreValidation,
      loadRecord: loadSnapshotRecord,
      save: saveSnapshot,
    } = snapshotStore;
    const encodeSnapshotRecord = (
      _sessionId: string,
      _namespace: 'snapshot' | `named/${string}`,
      _revision: number,
      payload: string,
    ): string => payload;
    const openSnapshot = (
      row: SnapshotRow | NamedSnapshotRow,
      _namespace: 'snapshot' | `named/${string}`,
    ): string => row.state_json;
    const deleteSnapshot = db.query('DELETE FROM runtime_snapshots WHERE session_id = ?');
    const deleteNamedSnapshots = db.query(
      'DELETE FROM runtime_named_snapshots WHERE session_id = ?',
    );
    const deleteNamedSnapshotsAfter = db.query(
      'DELETE FROM runtime_named_snapshots WHERE session_id = ? AND event_position > ?',
    );
    const upsertNamedSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_named_snapshots (session_id, name, event_position, state_json, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const insertForkNamedSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_named_snapshots (session_id, name, event_position, state_json, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const selectNamedSnapshot = db.query<NamedSnapshotRow, [string, string]>(
      'SELECT session_id AS thread_id, name, state_json, event_position, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND name = ?',
    );
    const selectNamedSnapshotsForFork = db.query<NamedSnapshotRow, [string, number]>(
      'SELECT session_id AS thread_id, name, event_position, state_json, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND event_position <= ? ORDER BY event_position ASC, name ASC',
    );
    const listNamedSnapshotsQuery = db.query<
      { name: string; event_position: number; created_at: number; affected_file_count: number },
      [string]
    >(
      `SELECT s.name, s.event_position, s.created_at, (SELECT COUNT(DISTINCT p.path) FROM runtime_file_preimages p WHERE p.session_id = s.session_id AND p.event_position > s.event_position) AS affected_file_count FROM runtime_named_snapshots s WHERE s.session_id = ? ORDER BY s.event_position DESC, s.name DESC`,
    );
    const selectNamedSnapshotEntry = db.query<NamedSnapshotRow, [string, string]>(
      'SELECT session_id AS thread_id, name, event_position, state_json, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_named_snapshots WHERE session_id = ? AND name = ?',
    );
    const deleteFilePreimages = db.query('DELETE FROM runtime_file_preimages WHERE session_id = ?');
    const deleteFilePreimagesAfter = db.query(
      'DELETE FROM runtime_file_preimages WHERE session_id = ? AND event_position > ?',
    );
    const insertFilePreimage = db.query(
      'INSERT OR REPLACE INTO runtime_file_preimages (session_id, path, event_position, content, existed) VALUES (?, ?, ?, ?, ?)',
    );
    const selectFilePreimageInWindow = db.query<{ path: string }, [string, string, number]>(
      'SELECT path FROM runtime_file_preimages WHERE session_id = ? AND path = ? AND event_position > ? LIMIT 1',
    );
    const updateFilePostimageInWindow = db.query(
      `UPDATE runtime_file_preimages SET post_hash = ?, post_existed = ? WHERE rowid = (SELECT rowid FROM runtime_file_preimages WHERE session_id = ? AND path = ? AND event_position > ? ORDER BY event_position DESC LIMIT 1)`,
    );
    const selectLatestSnapshotPosition = db.query<{ event_position: number | null }, [string]>(
      'SELECT MAX(event_position) AS event_position FROM runtime_named_snapshots WHERE session_id = ?',
    );
    const selectFileRestorePlan = db.query<
      {
        path: string;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
      },
      [string, number]
    >(
      `WITH bounds AS (SELECT session_id, path, MIN(event_position) AS min_position, MAX(event_position) AS max_position FROM runtime_file_preimages WHERE session_id = ? AND event_position > ? GROUP BY session_id, path) SELECT first.path AS path, first.content AS content, first.existed AS existed, last.post_hash AS post_hash, last.post_existed AS post_existed FROM bounds JOIN runtime_file_preimages first ON first.session_id = bounds.session_id AND first.path = bounds.path AND first.event_position = bounds.min_position JOIN runtime_file_preimages last ON last.session_id = bounds.session_id AND last.path = bounds.path AND last.event_position = bounds.max_position`,
    );
    const selectFilePreimagesForFork = db.query<
      {
        path: string;
        event_position: number;
        content: string | null;
        existed: number;
        post_hash: string | null;
        post_existed: number | null;
        created_at: number;
      },
      [string, number]
    >(
      'SELECT path, event_position, content, existed, post_hash, post_existed, created_at FROM runtime_file_preimages WHERE session_id = ? AND event_position <= ? ORDER BY event_position ASC, path ASC',
    );
    const insertForkFilePreimage = db.query(
      'INSERT OR REPLACE INTO runtime_file_preimages (session_id, path, event_position, content, existed, post_hash, post_existed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const deleteEffectLeases = db.query('DELETE FROM runtime_effect_leases WHERE session_id = ?');
    const selectSessionRevision = db.query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    );
    const selectSessionBinding = workspaceBinding
      ? db.query<SqliteRuntimeSessionBinding, [string]>(
          'SELECT worker_scope_id AS workerScopeId, project_id AS projectId, workspace_digest AS workspaceDigest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
        )
      : undefined;
    const selectCommandReceipt = workspaceBinding
      ? db.query<
          {
            scope_session_id: string;
            command_id: string;
            request_digest: string;
            target_session_id: string;
            original_receipt_json: string;
            committed_revision: number;
            committed_at: number;
          },
          [string, string]
        >(
          'SELECT scope_session_id, command_id, request_digest, target_session_id, original_receipt_json, committed_revision, committed_at FROM runtime_command_receipts WHERE scope_session_id = ? AND command_id = ? LIMIT 1',
        )
      : undefined;
    const selectSessionTombstone = workspaceBinding
      ? db.query<{ session_id: string }, [string]>(
          'SELECT session_id FROM session_workspace_tombstone WHERE session_id = ? LIMIT 1',
        )
      : undefined;
    const readCommandReceipt = workspaceBinding
      ? (receipt: RuntimeStoredCommandReceipt): RuntimeStoredCommandReceipt | null => {
          const row = selectCommandReceipt?.get(receipt.scopeSessionId, receipt.commandId);
          return row
            ? {
                scopeSessionId: row.scope_session_id,
                commandId: row.command_id,
                requestDigest: row.request_digest,
                targetSessionId: row.target_session_id,
                originalReceiptJson: row.original_receipt_json,
                committedRevision: row.committed_revision,
                committedAt: row.committed_at,
              }
            : null;
        }
      : undefined;
    const assertSessionAbsent = workspaceBinding
      ? (sessionId: string): void => {
          const existing = selectSessionRevision.get(sessionId);
          if (existing) {
            throw new SqliteRuntimeRevisionConflictError(
              sessionId,
              0,
              existing.revision,
              `Initial Controller creation requires an absent Runtime session: ${sessionId}.`,
            );
          }
          if (selectSessionTombstone?.get(sessionId)) {
            throw new SqliteRuntimeFormatMismatchError(this.stateSchemaVersion, this.formatEpoch);
          }
        }
      : undefined;
    const tombstones = workspaceBinding
      ? createSqliteWorkspaceTombstoneStore(db, markWorkspaceWritten)
      : undefined;
    const effectLeases = createSqliteEffectLeaseStore(db, () => this.#closed, markWorkspaceWritten);

    const persistNamedSnapshot = (
      sessionId: string,
      name: string,
      eventPosition: number,
      json: string,
      stateRevision: number,
      _stateChecksum: string,
      schemaVersion: number,
      createdAt?: number,
    ): void => {
      markWorkspaceWritten?.();
      {
        const encodedRecord = encodeSnapshotRecord(sessionId, `named/${name}`, stateRevision, json);
        const args = [
          sessionId,
          name,
          eventPosition,
          encodedRecord,
          stateRevision,
          checksum(encodedRecord),
          schemaVersion,
          this.formatEpoch,
          ...(createdAt === undefined ? [] : [createdAt]),
        ];
        if (createdAt === undefined) upsertNamedSnapshot.run(...args);
        else insertForkNamedSnapshot.run(...args);
      }
    };
    const sessions: SessionStore<Event, State> = {
      appendEvents: (
        sessionId: string,
        events: readonly Event[],
        metadata?: readonly RuntimeEventMetadata[],
      ) => {
        if (this.#closed || events.length === 0) return;
        markWorkspaceWritten?.();
        db.transaction(() => {
          ensureSession(sessionId);
          insertEvents(sessionId, events, metadata);
        })();
      },
      loadEventsStrict: loadEvents,
      saveSnapshot: (sessionId: string, state: State) => {
        if (this.#closed) return;
        db.transaction(() => saveSnapshot(sessionId, state))();
      },
      loadSnapshot: <T = State>(sessionId: string) =>
        loadSnapshotRecord<T>(sessionId)?.state ?? null,
      loadSnapshotRecord,
      getLastEventPosition: (sessionId: string) => (this.#closed ? 0 : lastEvent(sessionId)),
      listSessions: (query = '', limit = 50): RuntimeSessionInfo[] => {
        if (this.#closed) return [];
        const needle = query.trim().toLowerCase();
        return sessionMetadata
          .list(needle ? Math.max(limit, 200) : limit)
          .map((row) => {
            let firstText = '';
            try {
              firstText = findFirstSessionSummary(row.thread_id)?.searchText ?? '';
            } catch {
              // Session summaries are advisory. One malformed/unknown event
              // may make that session unopenable, but it must not remove every
              // healthy session from discovery.
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
            threadId: row.thread_id,
            name: row.name || firstText || row.thread_id,
            updatedAt: row.updated_at,
            needsSmartName: !row.name,
          }));
      },
      setSessionName: (sessionId: string, name: string) => {
        if (!this.#closed) {
          db.transaction(() => {
            ensureSession(sessionId);
            sessionMetadata.setName(sessionId, name);
          })();
        }
      },
      getSessionModelRoute: (sessionId): RuntimeSessionModelRoute | null => {
        if (this.#closed) return null;
        return sessionMetadata.getModelRoute(sessionId);
      },
      setSessionModelRoute: (sessionId: string, route: RuntimeSessionModelRoute) => {
        if (!this.#closed && sessionId && route.provider.trim() && route.name.trim()) {
          ensureSession(sessionId);
          sessionMetadata.setModelRoute(sessionId, route);
        }
      },
      deleteSession: (sessionId: string, deletion?: RuntimeSessionDeletionInput) => {
        if (this.#closed) return;
        // A receipt-bearing delete is the Runtime decision. Reserve the Store
        // writer up front so revision validation, retained receipt insertion,
        // and removal of every Session fact share one crash boundary.
        markWorkspaceWritten?.();
        db.run('BEGIN IMMEDIATE');
        try {
          const ownership = selectSessionBinding?.get(sessionId);
          if (deletion) {
            const current = selectSessionRevision.get(sessionId);
            if (!current || current.revision !== deletion.expectedRevision) {
              throw new SqliteRuntimeRevisionConflictError(
                sessionId,
                deletion.expectedRevision,
                current?.revision ?? null,
              );
            }
            assertSqliteRuntimeCommandReceipt(
              deletion.commandReceipt,
              sessionId,
              deletion.expectedRevision,
            );
            if (
              workspaceBinding &&
              (!ownership || ownership.workerScopeId !== workspaceBinding.workerScopeId)
            ) {
              throw new SqliteRuntimeFormatMismatchError(this.stateSchemaVersion, this.formatEpoch);
            }
          }
          if (workspaceBinding && ownership) {
            tombstones?.write({
              sessionId,
              workerScopeId: ownership.workerScopeId,
              projectId: ownership.projectId,
              workspaceDigest: ownership.workspaceDigest,
              deletedRevision:
                deletion?.expectedRevision ?? selectSessionRevision.get(sessionId)?.revision ?? 0,
              deletedAt: Math.floor(Date.now() / 1000),
            });
          }
          eventStore.deleteAll(sessionId);
          deleteSnapshot.run(sessionId);
          deleteNamedSnapshots.run(sessionId);
          deleteFilePreimages.run(sessionId);
          deleteEffectLeases.run(sessionId);
          recoveryIdentities.deleteValue(sessionId);
          sessionMetadata.delete(sessionId);
          if (deletion) {
            commandReceiptWriter.insert(
              deletion.commandReceipt,
              sessionId,
              deletion.expectedRevision,
              ownership ?? undefined,
            );
          }
          db.run('COMMIT');
        } catch (error) {
          try {
            db.run('ROLLBACK');
          } catch {
            /* SQLite may already have rolled back a failed statement. */
          }
          if (deletion && isSqliteRuntimeCommandReceiptConstraint(error)) {
            throw new SqliteRuntimeCommandReceiptConflictError(
              deletion.commandReceipt.scopeSessionId,
              deletion.commandReceipt.commandId,
              error,
            );
          }
          throw error;
        }
      },
    };
    this.sessions = Object.freeze(sessions);

    const transactionPort = createSqliteRuntimeTransactionPort({
      db,
      isClosed: () => this.#closed,
      hasEffectLease: (sessionId, effectId, ownerId, observedAtMs) =>
        effectLeases.hasLease(sessionId, effectId, ownerId, observedAtMs),
      readSnapshotBoundary: (sessionId) => snapshotStore.getRollingRow(sessionId),
      readSnapshotRevision: (sessionId) => snapshotStore.getRevision(sessionId),
      lastEventPosition: lastEvent,
      ensureSession,
      insertEvents,
      encodeSnapshot,
      persistSnapshot,
      receiptWriter: commandReceiptWriter,
      readSessionBinding: (sessionId) => selectSessionBinding?.get(sessionId) ?? null,
      readCommandReceipt,
      assertSessionAbsent,
      initialController:
        workspaceBinding && !runStoreTarget
          ? {
              create: (request, mode) =>
                createSqliteWorkspaceInitialControllerTransaction({
                  db,
                  binding: workspaceBinding,
                  request,
                  mode,
                }),
            }
          : undefined,
      beforeWrite: markWorkspaceWritten,
      runStore,
    });
    this.transactions = transactionPort;
    this.workspaceSessionCreation = transactionPort.createSessionWithInitialController
      ? Object.freeze({ create: transactionPort.createSessionWithInitialController })
      : undefined;
    this.effects = effectLeases.port;

    const loadNamed = <T = State>(sessionId: string, name: string): T | null => {
      if (this.#closed) return null;
      const row = selectNamedSnapshot.get(sessionId, name);
      if (!row || checksum(row.state_json) !== row.state_checksum) return null;
      try {
        return this.#codec.decodeState<T>(openSnapshot(row, `named/${name}`));
      } catch {
        return null;
      }
    };
    const fork = (
      sourceSessionId: string,
      snapshotId: string,
      targetSessionId: string,
      targetRecoveryIdentityKey: string,
      commandEvidence?: RuntimeCommandForkInput['commandEvidence'],
    ): RuntimeCommandForkResult | { readonly status: 'applied' } => {
      const unavailable = (): RuntimeCommandForkResult => ({ status: 'unavailable' });
      if (
        this.#closed ||
        !sourceSessionId ||
        !targetSessionId ||
        sourceSessionId === targetSessionId ||
        !isCanonicalRecoveryIdentity(targetRecoveryIdentityKey) ||
        (commandEvidence !== undefined &&
          (commandEvidence.scopeSessionId !== sourceSessionId ||
            commandEvidence.targetSessionId !== targetSessionId))
      ) {
        return unavailable();
      }
      let receipt: ReturnType<typeof createRuntimeStoredCommandReceipt> | undefined;
      try {
        markWorkspaceWritten?.();
        db.run('BEGIN IMMEDIATE');
        const current = snapshotId === '__runtime_current__';
        const rolling = current ? snapshotStore.getRollingRow(sourceSessionId) : null;
        const named = current ? null : selectNamedSnapshot.get(sourceSessionId, snapshotId);
        const sourceRow = rolling ?? named;
        if (!sourceRow || checksum(sourceRow.state_json) !== sourceRow.state_checksum) {
          db.run('ROLLBACK');
          return unavailable();
        }
        let state: State;
        try {
          state = this.#codec.decodeState<State>(
            openSnapshot(sourceRow, current ? 'snapshot' : `named/${snapshotId}`),
          );
          const eventRevision = eventStore.revisionAtOrBefore(
            sourceSessionId,
            sourceRow.event_position,
          );
          restoreValidation(state, sourceSessionId, sourceRow, eventRevision);
          if (
            (this.#codec.canFork && !this.#codec.canFork(state)) ||
            sourceRow.schema_version !== this.stateSchemaVersion ||
            sourceRow.state_revision !== eventRevision
          ) {
            db.run('ROLLBACK');
            return unavailable();
          }
        } catch {
          db.run('ROLLBACK');
          return unavailable();
        }
        let sourceEvents: StoredRuntimeEvent<Event>[];
        try {
          sourceEvents = loadEvents(sourceSessionId).filter(
            (entry) =>
              entry.id <= sourceRow.event_position &&
              (!current || !this.#codec.isCurrentPendingInteractionRequest?.(state, entry.event)),
          );
        } catch {
          db.run('ROLLBACK');
          return unavailable();
        }
        const sourceNamed = selectNamedSnapshotsForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceFiles = selectFilePreimagesForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceRoute = sessionMetadata.getModelRoute(sourceSessionId);
        const snapshotRecoveryIdentity = this.#codec.recoveryIdentity?.(state);
        const persistedRecoveryIdentity = recoveryIdentities.readValue(sourceSessionId);
        if (
          (snapshotRecoveryIdentity !== undefined &&
            !isCanonicalRecoveryIdentity(snapshotRecoveryIdentity)) ||
          (persistedRecoveryIdentity !== undefined &&
            !isCanonicalRecoveryIdentity(persistedRecoveryIdentity)) ||
          (snapshotRecoveryIdentity !== undefined &&
            persistedRecoveryIdentity !== undefined &&
            snapshotRecoveryIdentity !== persistedRecoveryIdentity)
        ) {
          db.run('ROLLBACK');
          return unavailable();
        }
        const sourceRecoveryIdentity = persistedRecoveryIdentity ?? snapshotRecoveryIdentity;
        if (
          (this.#codec.recoveryIdentity && sourceRecoveryIdentity === undefined) ||
          sourceRecoveryIdentity === targetRecoveryIdentityKey
        ) {
          db.run('ROLLBACK');
          return unavailable();
        }
        const forkState = this.#codec.rebindForkState(
          state,
          targetSessionId,
          targetRecoveryIdentityKey,
        );
        const encodedFork = encodeSnapshot(forkState);
        try {
          this.#codec.validateSnapshot?.({
            state: forkState,
            sessionId: targetSessionId,
            eventPosition: 0,
            stateRevision: encodedFork.metadata.stateRevision,
            schemaVersion: encodedFork.metadata.schemaVersion,
            eventRevision: encodedFork.metadata.stateRevision,
          });
          if (commandEvidence) {
            receipt = createRuntimeStoredCommandReceipt(
              commandEvidence,
              encodedFork.metadata.stateRevision,
            );
          }
        } catch {
          db.run('ROLLBACK');
          return unavailable();
        }
        eventStore.deleteAll(targetSessionId);
        deleteSnapshot.run(targetSessionId);
        deleteNamedSnapshots.run(targetSessionId);
        deleteFilePreimages.run(targetSessionId);
        recoveryIdentities.deleteValue(targetSessionId);
        sessionMetadata.delete(targetSessionId);
        ensureSession(targetSessionId, forkState);
        if (sourceRecoveryIdentity !== undefined) {
          if (persistedRecoveryIdentity === undefined) {
            recoveryIdentities.putValue(sourceSessionId, sourceRecoveryIdentity);
          }
          recoveryIdentities.putValue(targetSessionId, targetRecoveryIdentityKey);
        }
        if (sourceRoute) sessionMetadata.setModelRoute(targetSessionId, sourceRoute);
        const positions = new Map<number, number>();
        for (const entry of sourceEvents) {
          const eventId = entry.event_id ?? `${targetSessionId}:${entry.revision}`;
          const serialized =
            this.#codec.encodeHistoricalEvent?.(entry.event) ??
            this.#codec.encodeEvent(entry.event);
          eventStore.insertSerializedForkEvent({
            sessionId: targetSessionId,
            eventJson: serialized,
            eventId,
            revision: entry.revision ?? 0,
            causationId: entry.causation_id ?? null,
            occurredAt: entry.occurred_at ?? null,
            createdAt: entry.created_at,
          });
          positions.set(entry.id, entry.revision ?? 0);
        }
        const remap = (position: number): number => {
          let target = 0;
          for (const entry of sourceEvents) {
            if (entry.id > position) break;
            target = positions.get(entry.id) ?? target;
          }
          return target;
        };
        for (const file of sourceFiles) {
          insertForkFilePreimage.run(
            targetSessionId,
            file.path,
            remap(file.event_position),
            file.content,
            file.existed,
            file.post_hash,
            file.post_existed,
            file.created_at,
          );
        }
        persistSnapshot(
          targetSessionId,
          encodedFork.json,
          remap(sourceRow.event_position),
          encodedFork.metadata.stateRevision,
          encodedFork.metadata.stateChecksum,
          encodedFork.metadata.schemaVersion,
        );
        const runFork = runStore?.forkSession({
          sourceSessionId,
          targetSessionId,
          throughRevision: sourceRow.state_revision,
        });
        if (runFork?.status === 'invalid_boundary') {
          db.run('ROLLBACK');
          return unavailable();
        }
        for (const snapshot of sourceNamed) {
          try {
            if (checksum(snapshot.state_json) !== snapshot.state_checksum) continue;
            const namedState = this.#codec.decodeState<State>(
              openSnapshot(snapshot, `named/${snapshot.name}`),
            );
            if (this.#codec.canFork && !this.#codec.canFork(namedState)) continue;
            const rebound = this.#codec.rebindForkState(
              namedState,
              targetSessionId,
              targetRecoveryIdentityKey,
            );
            this.#codec.validateSnapshot?.({
              state: rebound,
              sessionId: targetSessionId,
              eventPosition: remap(snapshot.event_position),
              stateRevision: snapshot.state_revision,
              schemaVersion: snapshot.schema_version,
              eventRevision: snapshot.state_revision,
            });
            const encodedNamed = encodeSnapshot(rebound, {
              eventPosition: remap(snapshot.event_position),
              stateRevision: snapshot.state_revision,
              stateChecksum: '',
              schemaVersion: snapshot.schema_version,
            });
            persistNamedSnapshot(
              targetSessionId,
              snapshot.name,
              remap(snapshot.event_position),
              encodedNamed.json,
              snapshot.state_revision,
              encodedNamed.metadata.stateChecksum,
              snapshot.schema_version,
              snapshot.created_at,
            );
          } catch {
            /* corrupt or rejected recovery points are omitted */
          }
        }
        if (receipt) {
          commandReceiptWriter.insert(receipt, targetSessionId, encodedFork.metadata.stateRevision);
        }
        db.run('COMMIT');
        return receipt ? { status: 'applied', receipt } : { status: 'applied' };
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* SQLite may already have rolled back after a constraint failure. */
        }
        if (receipt && isSqliteRuntimeCommandReceiptConstraint(error)) {
          throw new SqliteRuntimeCommandReceiptConflictError(
            receipt.scopeSessionId,
            receipt.commandId,
            error,
          );
        }
        throw error;
      }
    };
    this.checkpoints = Object.freeze({
      saveNamedSnapshot: (
        sessionId: string,
        name: string,
        state: State,
        eventPosition?: number,
      ) => {
        if (this.#closed) return;
        db.transaction(() => {
          const encoded = encodeSnapshot(state);
          ensureSession(sessionId, state);
          persistNamedSnapshot(
            sessionId,
            name,
            eventPosition ?? lastEvent(sessionId),
            encoded.json,
            encoded.metadata.stateRevision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
        })();
      },
      loadNamedSnapshot: loadNamed,
      listNamedSnapshots: (sessionId: string) => {
        if (this.#closed) return [];
        const events = loadEvents(sessionId);
        return listNamedSnapshotsQuery.all(sessionId).map((row) => {
          const target = events.find(
            (entry) =>
              entry.id > row.event_position &&
              this.#codec.eventSummary?.(entry.event)?.isSessionNameCandidate,
          );
          const summary = target ? this.#codec.eventSummary?.(target.event) : null;
          return {
            snapshotId: row.name,
            eventPosition: row.event_position,
            createdAt: row.created_at,
            ...(summary?.searchText != null ? { targetMessage: summary.searchText } : {}),
            ...(target ? { targetMessageCreatedAt: target.created_at } : {}),
            affectedFileCount: row.affected_file_count,
          };
        });
      },
      getNamedSnapshotEntry: (sessionId: string, snapshotId: string) => {
        if (this.#closed) return null;
        const row = selectNamedSnapshotEntry.get(sessionId, snapshotId);
        return row
          ? { snapshotId: row.name, eventPosition: row.event_position, createdAt: row.created_at }
          : null;
      },
      restoreNamedSnapshot: (sessionId: string, snapshotId: string): boolean => {
        if (this.#closed) return false;
        const row = selectNamedSnapshot.get(sessionId, snapshotId);
        if (!row || checksum(row.state_json) !== row.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(openSnapshot(row, `named/${snapshotId}`));
          const eventRevision = eventStore.revisionAtOrBefore(sessionId, row.event_position);
          restoreValidation(state, sessionId, row, eventRevision);
          if (
            row.schema_version !== this.stateSchemaVersion ||
            row.event_position > lastEvent(sessionId) ||
            row.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        markWorkspaceWritten?.();
        return db.transaction(() => {
          const runRewind = runStore?.rewindSession(sessionId, row.state_revision);
          if (runRewind?.status === 'invalid_boundary') return false;
          eventStore.deleteAfter(sessionId, row.event_position);
          deleteNamedSnapshotsAfter.run(sessionId, row.event_position);
          deleteFilePreimagesAfter.run(sessionId, row.event_position);
          const encoded = encodeSnapshot(state);
          persistSnapshot(
            sessionId,
            encoded.json,
            row.event_position,
            row.state_revision,
            encoded.metadata.stateChecksum,
            encoded.metadata.schemaVersion,
          );
          ensureSession(sessionId, state);
          return true;
        })();
      },
      forkSession: (
        sourceSessionId: string,
        snapshotId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ): boolean =>
        fork(sourceSessionId, snapshotId, targetSessionId, targetRecoveryIdentityKey).status ===
        'applied',
      forkSessionForCommand: (input: RuntimeCommandForkInput): RuntimeCommandForkResult => {
        const result = fork(
          input.sourceSessionId,
          input.snapshotId,
          input.targetSessionId,
          input.targetRecoveryIdentityKey,
          input.commandEvidence,
        );
        return result.status === 'applied' && 'receipt' in result
          ? result
          : { status: 'unavailable' };
      },
      forkCurrentSession: (
        sourceSessionId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ) =>
        this.checkpoints.forkSession(
          sourceSessionId,
          '__runtime_current__',
          targetSessionId,
          targetRecoveryIdentityKey,
        ),
      recordFilePreimage: (
        sessionId: string,
        path: string,
        content: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          if (selectFilePreimageInWindow.get(sessionId, path, boundary)) return;
          markWorkspaceWritten?.();
          insertFilePreimage.run(sessionId, path, lastEvent(sessionId), content, existed ? 1 : 0);
        } catch {
          /* best effort by contract */
        }
      },
      recordFilePostimage: (
        sessionId: string,
        path: string,
        contentHash: string | null,
        existed: boolean,
      ) => {
        if (this.#closed || !sessionId || !path) return;
        try {
          const boundary = selectLatestSnapshotPosition.get(sessionId)?.event_position ?? -1;
          markWorkspaceWritten?.();
          updateFilePostimageInWindow.run(contentHash, existed ? 1 : 0, sessionId, path, boundary);
        } catch {
          /* best effort by contract */
        }
      },
      fileRestorePlan: (sessionId: string, eventPosition: number): RuntimeFileRestoreMaterial[] =>
        this.#closed
          ? []
          : selectFileRestorePlan.all(sessionId, eventPosition).map((row) => ({
              path: row.path,
              content: row.content,
              existed: row.existed === 1,
              postHash: row.post_hash,
              postExisted: row.post_existed == null ? null : row.post_existed === 1,
            })),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#db) {
      try {
        this.#db.fileControl('main', constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      } catch {
        /* best effort */
      }
      try {
        this.#db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort */
      }
      this.#db.close();
    }
  }
}

export function createSqliteRuntimeStorageAdapter<Event = unknown, State = unknown>(
  input: SqliteRuntimeStorageInput<Event, State>,
): RuntimeStorage<Event, State> & {
  readonly workspaceAuthority?: SqliteWorkspaceAuthority;
  readonly directoryOutbox?: SqliteWorkspaceDirectoryOutbox;
  readonly openWorkspaceLogQuery?: (
    currentEventTypes: readonly string[],
  ) => RuntimeLogQueryPort<Event>;
  readonly workspaceCheckpointQuery?: SqliteWorkspaceCheckpointQuery;
  readonly workspaceSessionCreation?: SqliteWorkspaceSessionCreationPort<Event, State>;
} {
  return new SqliteRuntimeStorageAdapter(input);
}
