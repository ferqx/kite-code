import { constants, Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ArtifactPort,
  type CheckpointPort,
  createArtifactPort,
  type EffectLeasePort,
  type RuntimeEventMetadata,
  type RuntimeFileRestoreMaterial,
  type RuntimeRecoveryIdentityPort,
  type RuntimeSessionInfo,
  type RuntimeSessionModelRoute,
  type RuntimeSnapshotMetadata,
  type RuntimeStorage,
  type RuntimeTransactionInput,
  type SessionStore,
  type StoredRuntimeEvent,
} from '@kite/runtime-host/storage';
import {
  assertNoFollowDatabasePath,
  assertNonEmptySessionId,
  assertSqliteRuntimeStorageCanOpen,
  checksum,
  defaultSqliteRuntimeJournalMode,
  type EventRow,
  eventMetadataAt,
  isCanonicalRecoveryIdentity,
  type NamedSnapshotRow,
  recoveryIdentityMetaKey,
  type SnapshotRow,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SqliteRuntimeEffectLeaseConflictError,
  SqliteRuntimeFormatMismatchError,
  SqliteRuntimeRevisionConflictError,
  type SqliteRuntimeSnapshotCodec,
  type SqliteRuntimeStorageInput,
  SqliteRuntimeStorageOpenError,
} from './preflight';

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
  readonly #db: Database;
  readonly #codec: SqliteRuntimeSnapshotCodec<Event, State>;
  #closed = false;

  constructor(input: SqliteRuntimeStorageInput<Event, State>) {
    if (!input.databasePath || !input.codec) {
      throw new SqliteRuntimeStorageOpenError(
        'SQLite Runtime storage requires a databasePath and codec.',
      );
    }
    const profile = {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    };
    this.stateSchemaVersion = profile.stateSchemaVersion;
    this.storeSchemaVersion = profile.storeSchemaVersion;
    this.formatEpoch = profile.formatEpoch;
    this.#codec = input.codec;
    const baseArtifacts = input.artifacts ?? createArtifactPort();
    assertNoFollowDatabasePath(input.databasePath);
    assertSqliteRuntimeStorageCanOpen(input.databasePath, input.codec, input.sessionId);
    if (input.databasePath !== ':memory:')
      mkdirSync(dirname(input.databasePath), { recursive: true });
    const db = new Database(
      input.databasePath,
      constants.SQLITE_OPEN_READWRITE |
        constants.SQLITE_OPEN_CREATE |
        constants.SQLITE_OPEN_NOFOLLOW,
    );
    const journalMode = input.options?.journalMode ?? defaultSqliteRuntimeJournalMode();
    try {
      db.run('PRAGMA busy_timeout = 5000');
      db.run(`PRAGMA journal_mode = ${journalMode}`);
      db.run('BEGIN IMMEDIATE');
      try {
        db.run(
          `CREATE TABLE IF NOT EXISTS runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        db.run(`CREATE TABLE IF NOT EXISTS runtime_events (
            session_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            schema_version INTEGER NOT NULL, event_json TEXT NOT NULL,
            causation_id TEXT, occurred_at TEXT, created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, event_id), UNIQUE (session_id, sequence))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_sessions (
            session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_digest TEXT NOT NULL,
            state_schema INTEGER NOT NULL, format_epoch TEXT NOT NULL, revision INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_snapshots (
            session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, format_epoch TEXT NOT NULL,
            revision INTEGER NOT NULL, state_json TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            state_checksum TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT (unixepoch()))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
            session_id TEXT NOT NULL, name TEXT NOT NULL, schema_version INTEGER NOT NULL,
            format_epoch TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
            event_position INTEGER NOT NULL DEFAULT 0, state_checksum TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, name))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_file_preimages (
            session_id TEXT NOT NULL, path TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0,
            content TEXT, existed INTEGER NOT NULL DEFAULT 1, post_hash TEXT, post_existed INTEGER,
            created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (session_id, path, event_position))`);
        db.run(`CREATE TABLE IF NOT EXISTS runtime_effect_leases (
            session_id TEXT NOT NULL, effect_id TEXT NOT NULL, owner_id TEXT NOT NULL,
            lease_revision INTEGER NOT NULL DEFAULT 0, certainty TEXT NOT NULL DEFAULT 'certain',
            expires_at_ms INTEGER NOT NULL, PRIMARY KEY (session_id, effect_id))`);
        db.run(
          'CREATE INDEX IF NOT EXISTS runtime_events_session_sequence ON runtime_events(session_id, sequence)',
        );
        db.run(
          'CREATE INDEX IF NOT EXISTS runtime_file_preimages_position ON runtime_file_preimages(session_id, event_position)',
        );
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('format_version', ?)",
          [String(profile.storeSchemaVersion)],
        );
        db.run(
          "INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('runtime_format_epoch', ?)",
          [profile.formatEpoch],
        );
        const marker = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'format_version'",
          )
          .get();
        const epoch = db
          .query<{ value: string }, []>(
            "SELECT value FROM runtime_store_meta WHERE key = 'runtime_format_epoch'",
          )
          .get();
        if (
          !marker ||
          Number(marker.value) !== profile.storeSchemaVersion ||
          !epoch ||
          epoch.value !== profile.formatEpoch
        ) {
          throw new SqliteRuntimeFormatMismatchError(
            Number(marker?.value) || null,
            epoch?.value ?? null,
          );
        }
        db.run('COMMIT');
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* begin may have failed */
        }
        throw error;
      }
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
    this.recoveryIdentities = Object.freeze({
      read: (sessionId: string): string | null => {
        assertStorageOpen();
        const key = recoveryIdentityMetaKey(sessionId);
        const row = selectRecoveryIdentity.get(key);
        if (!row) return null;
        if (!isCanonicalRecoveryIdentity(row.value)) {
          throw new SqliteRuntimeStorageOpenError(
            'Persisted runtime recovery identity is malformed.',
          );
        }
        return row.value;
      },
      getOrCreate: (sessionId: string, allocate: () => string): string => {
        assertNonEmptySessionId(sessionId);
        if (typeof allocate !== 'function') {
          throw new SqliteRuntimeStorageOpenError(
            'Runtime recovery identity requires a Host allocator.',
          );
        }
        const key = recoveryIdentityMetaKey(sessionId);
        return withImmediateTransaction(() => {
          const existing = selectRecoveryIdentity.get(key)?.value;
          if (existing !== undefined) {
            if (!isCanonicalRecoveryIdentity(existing)) {
              throw new SqliteRuntimeStorageOpenError(
                'Persisted runtime recovery identity is malformed.',
              );
            }
            return existing;
          }
          const allocated = allocate();
          if (!isCanonicalRecoveryIdentity(allocated)) {
            throw new SqliteRuntimeStorageOpenError(
              'Host recovery identity allocator returned an invalid key.',
            );
          }
          insertRecoveryIdentity.run(key, allocated);
          return allocated;
        });
      },
      remove: (sessionId: string): void => {
        const key = recoveryIdentityMetaKey(sessionId);
        withImmediateTransaction(() => {
          deleteRecoveryIdentity.run(key);
        });
      },
    });
    this.artifacts = baseArtifacts;
    const encodeEventRecord = (_sessionId: string, _eventId: string, payload: string): string =>
      payload;
    const openEvent = (row: EventRow): string => row.event_json;
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
    const insertEvent = db.query(
      'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())',
    );
    const insertEventWithMetadata = db.query(
      'INSERT OR IGNORE INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const insertForkEvent = db.query(
      'INSERT INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const selectEvents = db.query<EventRow, [string, number]>(
      'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC',
    );
    const selectAllEvents = db.query<EventRow, [string]>(
      'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC',
    );
    const upsertSnapshot = db.query(
      'INSERT OR REPLACE INTO runtime_snapshots (session_id, state_json, event_position, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
    );
    const selectSnapshot = db.query<SnapshotRow, [string]>(
      'SELECT session_id AS thread_id, state_json, event_position, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    const selectSnapshotRevision = db.query<{ state_revision: number }, [string]>(
      'SELECT revision AS state_revision FROM runtime_snapshots WHERE session_id = ?',
    );
    const selectLastEventPosition = db.query<{ id: number | null }, [string]>(
      'SELECT MAX(sequence) AS id FROM runtime_events WHERE session_id = ?',
    );
    const selectEventRevisionAtOrBefore = db.query<{ revision: number }, [string, number]>(
      'SELECT sequence AS revision FROM runtime_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1',
    );
    const upsertSession = db.query(
      'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, workspace_digest = excluded.workspace_digest, state_schema = excluded.state_schema, format_epoch = excluded.format_epoch, revision = excluded.revision, updated_at = unixepoch()',
    );
    const updateSessionName = db.query(
      'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE session_id = ?',
    );
    const selectSessionModelRoute = db.query<
      { model_provider: string | null; model_name: string | null },
      [string]
    >('SELECT model_provider, model_name FROM runtime_sessions WHERE session_id = ?');
    const updateSessionModelRoute = db.query(
      'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE session_id = ?',
    );
    const listSessionsQuery = db.query<
      { thread_id: string; name: string; updated_at: number },
      [number]
    >(
      'SELECT session_id AS thread_id, name, updated_at FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?',
    );
    const ensureSession = (sessionId: string, state?: State): void => {
      {
        const identity = state ? this.#codec.sessionIdentity?.(state) : undefined;
        if (!identity) {
          const existing = db
            .query<{ project_id: string; workspace_digest: string }, [string]>(
              'SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?',
            )
            .get(sessionId);
          if (existing) return;
          throw new SqliteRuntimeStorageOpenError(
            `Store session ${sessionId} has no State project identity.`,
          );
        }
        const existing = db
          .query<{ project_id: string; workspace_digest: string }, [string]>(
            'SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?',
          )
          .get(sessionId);
        if (
          existing &&
          (existing.project_id !== identity.projectId ||
            existing.workspace_digest !== identity.canonicalWorkspaceDigest)
        ) {
          throw new SqliteRuntimeFormatMismatchError(this.stateSchemaVersion, this.formatEpoch);
        }
        upsertSession.run(
          sessionId,
          identity.projectId,
          identity.canonicalWorkspaceDigest,
          this.stateSchemaVersion,
          this.formatEpoch,
          state ? this.#codec.snapshotMetadata(state).stateRevision : 0,
        );
      }
    };
    const deleteEvents = db.query('DELETE FROM runtime_events WHERE session_id = ?');
    const deleteEventsAfter = db.query(
      'DELETE FROM runtime_events WHERE session_id = ? AND sequence > ?',
    );
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
      `SELECT s.name, s.event_position, s.created_at, (SELECT COUNT(DISTINCT p.path) FROM runtime_file_preimages p WHERE p.session_id = s.session_id AND p.event_position > s.event_position) AS affected_file_count FROM runtime_named_snapshots s WHERE s.session_id = ? ORDER BY s.created_at DESC, s.name DESC`,
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
    const deleteSession = db.query('DELETE FROM runtime_sessions WHERE session_id = ?');
    const deleteExpiredLease = db.query(
      'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND expires_at_ms <= ?',
    );
    const insertLease = db.query(
      "INSERT OR IGNORE INTO runtime_effect_leases (session_id, effect_id, owner_id, lease_revision, certainty, expires_at_ms) VALUES (?, ?, ?, 0, 'certain', ?)",
    );
    const selectLease = db.query<{ owner_id: string }, [string, string, string, number]>(
      'SELECT owner_id FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const renewLease = db.query(
      'UPDATE runtime_effect_leases SET expires_at_ms = ?, lease_revision = lease_revision + 1 WHERE session_id = ? AND effect_id = ? AND owner_id = ? AND expires_at_ms > ?',
    );
    const releaseLease = db.query(
      'DELETE FROM runtime_effect_leases WHERE session_id = ? AND effect_id = ? AND owner_id = ?',
    );
    const selectRecoveryIdentity = db.query<{ value: string }, [string]>(
      'SELECT value FROM runtime_store_meta WHERE key = ?',
    );
    const insertRecoveryIdentity = db.query(
      'INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)',
    );
    const deleteRecoveryIdentity = db.query('DELETE FROM runtime_store_meta WHERE key = ?');

    const insertEvents = (
      sessionId: string,
      events: readonly Event[],
      metadata?: readonly RuntimeEventMetadata[],
      forkCreatedAt?: readonly number[],
    ): void => {
      for (const [index, event] of events.entries()) {
        const entry = eventMetadataAt(metadata, index);
        const implicitSequence = lastEvent(sessionId) + 1;
        const eventId = entry?.eventId ?? `${sessionId}:${implicitSequence}`;
        const json = encodeEventRecord(sessionId, eventId, this.#codec.encodeEvent(event));
        if (entry) {
          const statement = forkCreatedAt ? insertForkEvent : insertEventWithMetadata;
          if (forkCreatedAt)
            statement.run(
              ...[
                sessionId,
                json,
                entry.eventId,
                entry.revision,
                this.stateSchemaVersion,
                entry.causationId ?? null,
                entry.occurredAt ?? null,
                forkCreatedAt[index] ?? 0,
              ],
            );
          else
            statement.run(
              ...[
                sessionId,
                json,
                entry.eventId,
                entry.revision,
                this.stateSchemaVersion,
                entry.causationId ?? null,
                entry.occurredAt ?? new Date().toISOString(),
              ],
            );
        } else {
          if (forkCreatedAt)
            insertForkEvent.run(
              sessionId,
              json,
              eventId,
              implicitSequence,
              this.stateSchemaVersion,
              null,
              null,
              forkCreatedAt[index] ?? 0,
            );
          else {
            insertEvent.run(sessionId, eventId, implicitSequence, this.stateSchemaVersion, json);
          }
        }
      }
    };

    const snapshotMeta = (
      state: State,
      explicit?: RuntimeSnapshotMetadata,
    ): RuntimeSnapshotMetadata => {
      const metadata = this.#codec.snapshotMetadata(state);
      if (explicit) {
        if (
          explicit.schemaVersion !== this.stateSchemaVersion ||
          metadata.schemaVersion !== this.stateSchemaVersion ||
          explicit.stateRevision !== metadata.stateRevision
        ) {
          throw new SqliteRuntimeFormatMismatchError(explicit.schemaVersion, this.formatEpoch);
        }
        return explicit;
      }
      return {
        eventPosition: 0,
        stateRevision: metadata.stateRevision,
        stateChecksum: '',
        schemaVersion: metadata.schemaVersion,
      };
    };
    const encodeSnapshot = (
      state: State,
      explicit?: RuntimeSnapshotMetadata,
    ): { json: string; metadata: RuntimeSnapshotMetadata } => {
      const json = this.#codec.encodeState(state);
      const derived = snapshotMeta(state, explicit);
      return {
        json,
        metadata: { ...derived, stateChecksum: derived.stateChecksum || checksum(json) },
      };
    };
    const persistSnapshot = (
      sessionId: string,
      json: string,
      eventPosition: number,
      stateRevision: number,
      _stateChecksum: string,
      schemaVersion: number,
    ): void => {
      {
        const encodedRecord = encodeSnapshotRecord(sessionId, 'snapshot', stateRevision, json);
        upsertSnapshot.run(
          sessionId,
          encodedRecord,
          eventPosition,
          stateRevision,
          checksum(encodedRecord),
          schemaVersion,
          this.formatEpoch,
        );
      }
    };
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
    const restoreValidation = (
      state: State,
      sessionId: string,
      row: SnapshotRow | NamedSnapshotRow,
      eventRevision: number,
    ): void => {
      this.#codec.validateSnapshot?.({
        state,
        sessionId,
        eventPosition: row.event_position,
        stateRevision: row.state_revision,
        schemaVersion: row.schema_version,
        eventRevision,
      });
    };
    const loadEvents = (sessionId: string, since?: number): StoredRuntimeEvent<Event>[] => {
      if (this.#closed) return [];
      const rows =
        since == null ? selectAllEvents.all(sessionId) : selectEvents.all(sessionId, since);
      return rows.map((row) => ({
        id: row.id,
        thread_id: row.thread_id,
        event: this.#codec.decodeEvent(openEvent(row)),
        created_at: row.created_at,
        ...(row.event_id ? { event_id: row.event_id } : {}),
        revision: row.revision,
        ...(row.causation_id ? { causation_id: row.causation_id } : {}),
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
      }));
    };
    const loadSnapshotRecord = <T = State>(
      sessionId: string,
    ): { state: T; metadata: RuntimeSnapshotMetadata } | null => {
      if (this.#closed) return null;
      const row = selectSnapshot.get(sessionId);
      if (!row) {
        if (selectSessionModelRoute.get(sessionId)) {
          throw new SqliteRuntimeStorageOpenError(
            `Store session ${sessionId} is missing its State snapshot.`,
          );
        }
        return null;
      }
      if (row.state_checksum && checksum(row.state_json) !== row.state_checksum) {
        throw new SqliteRuntimeStorageOpenError(
          `Store session ${sessionId} snapshot checksum is invalid.`,
        );
      }
      try {
        return {
          state: this.#codec.decodeState<T>(openSnapshot(row, 'snapshot')),
          metadata: {
            eventPosition: row.event_position,
            stateRevision: row.state_revision,
            stateChecksum: row.state_checksum,
            schemaVersion: row.schema_version,
          },
        };
      } catch (error) {
        if (error instanceof SqliteRuntimeStorageOpenError) throw error;
        throw new SqliteRuntimeStorageOpenError(
          `Store session ${sessionId} snapshot integrity is invalid.`,
          error,
        );
      }
    };
    const lastEvent = (sessionId: string): number =>
      selectLastEventPosition.get(sessionId)?.id ?? 0;
    const saveSnapshot = (sessionId: string, state: State): void => {
      if (this.#closed) return;
      const encoded = encodeSnapshot(state);
      ensureSession(sessionId, state);
      const position = lastEvent(sessionId);
      persistSnapshot(
        sessionId,
        encoded.json,
        position,
        encoded.metadata.stateRevision,
        encoded.metadata.stateChecksum,
        encoded.metadata.schemaVersion,
      );
    };

    const sessions: SessionStore<Event, State> = {
      appendEvents: (
        sessionId: string,
        events: readonly Event[],
        metadata?: readonly RuntimeEventMetadata[],
      ) => {
        if (this.#closed || events.length === 0) return;
        db.transaction(() => {
          ensureSession(sessionId);
          insertEvents(sessionId, events, metadata);
        })();
      },
      loadEventsStrict: loadEvents,
      saveSnapshot,
      loadSnapshot: <T = State>(sessionId: string) =>
        loadSnapshotRecord<T>(sessionId)?.state ?? null,
      loadSnapshotRecord,
      getLastEventPosition: (sessionId: string) => (this.#closed ? 0 : lastEvent(sessionId)),
      listSessions: (query = '', limit = 50): RuntimeSessionInfo[] => {
        if (this.#closed) return [];
        const needle = query.trim().toLowerCase();
        return listSessionsQuery
          .all(needle ? Math.max(limit, 200) : limit)
          .map((row) => {
            const first = loadEvents(row.thread_id)
              .map((entry) => ({ entry, summary: this.#codec.eventSummary?.(entry.event) ?? null }))
              .find((candidate) => candidate.summary?.isSessionNameCandidate);
            const firstText = first?.summary?.searchText ?? '';
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
          ensureSession(sessionId);
          updateSessionName.run(name, sessionId);
        }
      },
      getSessionModelRoute: (sessionId): RuntimeSessionModelRoute | null => {
        if (this.#closed) return null;
        const row = selectSessionModelRoute.get(sessionId);
        return row?.model_provider && row.model_name
          ? { provider: row.model_provider, name: row.model_name }
          : null;
      },
      setSessionModelRoute: (sessionId: string, route: RuntimeSessionModelRoute) => {
        if (!this.#closed && sessionId && route.provider.trim() && route.name.trim()) {
          ensureSession(sessionId);
          updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), sessionId);
        }
      },
      deleteSession: (sessionId: string) => {
        if (!this.#closed)
          db.transaction(() => {
            deleteEvents.run(sessionId);
            deleteSnapshot.run(sessionId);
            deleteNamedSnapshots.run(sessionId);
            deleteFilePreimages.run(sessionId);
            deleteEffectLeases.run(sessionId);
            deleteRecoveryIdentity.run(recoveryIdentityMetaKey(sessionId));
            deleteSession.run(sessionId);
          })();
      },
    };
    this.sessions = Object.freeze(sessions);

    const commit = (input: RuntimeTransactionInput<Event, State>): void => {
      if (this.#closed) return;
      try {
        db.transaction(() => {
          if (
            input.requiredEffectLease &&
            !selectLease.get(
              input.sessionId,
              input.requiredEffectLease.effectId,
              input.requiredEffectLease.ownerId,
              input.requiredEffectLease.observedAtMs,
            )
          )
            throw new SqliteRuntimeEffectLeaseConflictError(
              input.sessionId,
              input.requiredEffectLease.effectId,
            );
          if (input.expectedRestoreBoundary) {
            const actual = selectSnapshot.get(input.sessionId);
            const expected = input.expectedRestoreBoundary.snapshot;
            const matches = expected
              ? actual != null &&
                actual.event_position === expected.eventPosition &&
                actual.state_revision === expected.stateRevision &&
                actual.state_checksum === expected.stateChecksum &&
                actual.schema_version === expected.schemaVersion
              : actual == null;
            const actualPosition = lastEvent(input.sessionId);
            if (!matches || actualPosition !== input.expectedRestoreBoundary.lastEventPosition)
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expected?.stateRevision ?? 0,
                actual?.state_revision ?? null,
                `Runtime restore boundary conflict for ${input.sessionId}: expected snapshot revision ${expected?.stateRevision ?? 'missing'} at event ${input.expectedRestoreBoundary.lastEventPosition}, found snapshot revision ${actual?.state_revision ?? 'missing'} at event ${actualPosition}.`,
              );
          }
          const firstRevision = input.metadata?.[0]?.revision;
          if (firstRevision != null) {
            const expectedRevision = firstRevision - 1;
            const actualRevision =
              selectSnapshotRevision.get(input.sessionId)?.state_revision ?? null;
            if (
              (actualRevision == null && expectedRevision !== 0) ||
              (actualRevision != null && actualRevision !== expectedRevision)
            )
              throw new SqliteRuntimeRevisionConflictError(
                input.sessionId,
                expectedRevision,
                actualRevision,
              );
          }
          ensureSession(input.sessionId, input.snapshot);
          insertEvents(input.sessionId, input.events, input.metadata);
          const encoded = encodeSnapshot(input.snapshot, input.snapshotMetadata);
          const position = input.snapshotMetadata?.eventPosition ?? lastEvent(input.sessionId);
          persistSnapshot(
            input.sessionId,
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
        )
          throw error;
        throw new Error(
          `Failed to persist runtime transaction for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };
    this.transactions = Object.freeze({
      commitDecision: commit,
      commitAttemptStart: commit,
      commitReceiptEvidence: commit,
      commitTerminalRecovery: commit,
    });
    this.effects = Object.freeze({
      tryAcquireEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        return db.transaction(() => {
          deleteExpiredLease.run(sessionId, effectId, now);
          insertLease.run(sessionId, effectId, ownerId, expiresAtMs);
          return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
        })();
      },
      renewEffectLease: (
        sessionId: string,
        effectId: string,
        ownerId: string,
        expiresAtMs: number,
      ): boolean => {
        if (this.#closed || expiresAtMs <= Date.now()) return false;
        const now = Date.now();
        renewLease.run(expiresAtMs, sessionId, effectId, ownerId, now);
        return Boolean(selectLease.get(sessionId, effectId, ownerId, now));
      },
      releaseEffectLease: (sessionId: string, effectId: string, ownerId: string): void => {
        if (!this.#closed) releaseLease.run(sessionId, effectId, ownerId);
      },
    });

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
    this.checkpoints = Object.freeze({
      saveNamedSnapshot: (
        sessionId: string,
        name: string,
        state: State,
        eventPosition?: number,
      ) => {
        if (this.#closed) return;
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
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sessionId, row.event_position)?.revision ?? 0;
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
        db.transaction(() => {
          deleteEventsAfter.run(sessionId, row.event_position);
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
        })();
        return true;
      },
      forkSession: (
        sourceSessionId: string,
        snapshotId: string,
        targetSessionId: string,
        targetRecoveryIdentityKey: string,
      ): boolean => {
        if (
          this.#closed ||
          !sourceSessionId ||
          !targetSessionId ||
          sourceSessionId === targetSessionId
        )
          return false;
        if (!isCanonicalRecoveryIdentity(targetRecoveryIdentityKey)) return false;
        const current = snapshotId === '__runtime_current__';
        const rolling = current ? selectSnapshot.get(sourceSessionId) : null;
        const named = current ? null : selectNamedSnapshot.get(sourceSessionId, snapshotId);
        const sourceRow = rolling ?? named;
        if (!sourceRow || checksum(sourceRow.state_json) !== sourceRow.state_checksum) return false;
        let state: State;
        try {
          state = this.#codec.decodeState<State>(
            openSnapshot(sourceRow, current ? 'snapshot' : `named/${snapshotId}`),
          );
          const eventRevision =
            selectEventRevisionAtOrBefore.get(sourceSessionId, sourceRow.event_position)
              ?.revision ?? 0;
          restoreValidation(state, sourceSessionId, sourceRow, eventRevision);
          if (this.#codec.canFork && !this.#codec.canFork(state)) return false;
          if (
            sourceRow.schema_version !== this.stateSchemaVersion ||
            sourceRow.state_revision !== eventRevision
          )
            return false;
        } catch {
          return false;
        }
        let sourceEvents: StoredRuntimeEvent<Event>[];
        try {
          sourceEvents = loadEvents(sourceSessionId).filter(
            (entry) =>
              entry.id <= sourceRow.event_position &&
              (!current || !this.#codec.isCurrentPendingInteractionRequest?.(state, entry.event)),
          );
        } catch {
          return false;
        }
        const sourceNamed = selectNamedSnapshotsForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceFiles = selectFilePreimagesForFork.all(
          sourceSessionId,
          sourceRow.event_position,
        );
        const sourceRoute = this.sessions.getSessionModelRoute(sourceSessionId);
        const snapshotRecoveryIdentity = this.#codec.recoveryIdentity?.(state);
        if (
          snapshotRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(snapshotRecoveryIdentity)
        )
          return false;
        const persistedRecoveryIdentity = selectRecoveryIdentity.get(
          recoveryIdentityMetaKey(sourceSessionId),
        )?.value;
        if (
          persistedRecoveryIdentity !== undefined &&
          !isCanonicalRecoveryIdentity(persistedRecoveryIdentity)
        )
          return false;
        if (
          snapshotRecoveryIdentity !== undefined &&
          persistedRecoveryIdentity !== undefined &&
          snapshotRecoveryIdentity !== persistedRecoveryIdentity
        )
          return false;
        const sourceRecoveryIdentity = persistedRecoveryIdentity ?? snapshotRecoveryIdentity;
        if (
          (this.#codec.recoveryIdentity && sourceRecoveryIdentity === undefined) ||
          sourceRecoveryIdentity === targetRecoveryIdentityKey
        )
          return false;
        const forkState = this.#codec.rebindForkState(
          state,
          targetSessionId,
          targetRecoveryIdentityKey,
        );
        try {
          const forkMetadata = this.#codec.snapshotMetadata(forkState);
          this.#codec.validateSnapshot?.({
            state: forkState,
            sessionId: targetSessionId,
            eventPosition: 0,
            stateRevision: forkMetadata.stateRevision,
            schemaVersion: forkMetadata.schemaVersion,
            eventRevision: forkMetadata.stateRevision,
          });
        } catch {
          return false;
        }
        db.transaction(() => {
          deleteEvents.run(targetSessionId);
          deleteSnapshot.run(targetSessionId);
          deleteNamedSnapshots.run(targetSessionId);
          deleteFilePreimages.run(targetSessionId);
          deleteRecoveryIdentity.run(recoveryIdentityMetaKey(targetSessionId));
          deleteSession.run(targetSessionId);
          ensureSession(targetSessionId, forkState);
          if (sourceRecoveryIdentity !== undefined) {
            if (persistedRecoveryIdentity === undefined) {
              insertRecoveryIdentity.run(
                recoveryIdentityMetaKey(sourceSessionId),
                sourceRecoveryIdentity,
              );
            }
            insertRecoveryIdentity.run(
              recoveryIdentityMetaKey(targetSessionId),
              targetRecoveryIdentityKey,
            );
          }
          if (sourceRoute)
            updateSessionModelRoute.run(sourceRoute.provider, sourceRoute.name, targetSessionId);
          const positions = new Map<number, number>();
          for (const entry of sourceEvents) {
            const eventId = entry.event_id ?? `${targetSessionId}:${entry.revision}`;
            const serialized = encodeEventRecord(
              targetSessionId,
              eventId,
              this.#codec.encodeEvent(entry.event),
            );
            insertForkEvent.run(
              ...[
                targetSessionId,
                serialized,
                eventId,
                entry.revision ?? 0,
                this.stateSchemaVersion,
                entry.causation_id ?? null,
                entry.occurred_at ?? null,
                entry.created_at,
              ],
            );
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
          for (const file of sourceFiles)
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
          const encodedFork = encodeSnapshot(forkState);
          persistSnapshot(
            targetSessionId,
            encodedFork.json,
            remap(sourceRow.event_position),
            encodedFork.metadata.stateRevision,
            encodedFork.metadata.stateChecksum,
            encodedFork.metadata.schemaVersion,
          );
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
        })();
        return true;
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
): RuntimeStorage<Event, State> {
  return new SqliteRuntimeStorageAdapter(input);
}
