import type { Database } from 'bun:sqlite';
import type { RuntimeSnapshotMetadata } from '@kite-ai/runtime-host/storage';
import {
  checksum,
  type NamedSnapshotRow,
  type SnapshotRow,
  SqliteRuntimeFormatMismatchError,
  type SqliteRuntimeSnapshotCodec,
  SqliteRuntimeStorageOpenError,
} from './preflight';

/** Rolling snapshot persistence over the adapter's one database connection. */
export function createSqliteSnapshotStore<Event, State>(input: {
  readonly db: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly isClosed: () => boolean;
  readonly ensureSession: (sessionId: string, state?: State) => void;
  readonly hasSessionMetadata: (sessionId: string) => boolean;
  readonly lastEventPosition: (sessionId: string) => number;
}) {
  const upsertSnapshot = input.db.query(
    'INSERT OR REPLACE INTO runtime_snapshots (session_id, state_json, event_position, revision, state_checksum, schema_version, format_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
  );
  const selectSnapshot = input.db.query<SnapshotRow, [string]>(
    'SELECT session_id AS thread_id, state_json, event_position, revision AS state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const selectSnapshotRevision = input.db.query<{ state_revision: number }, [string]>(
    'SELECT revision AS state_revision FROM runtime_snapshots WHERE session_id = ?',
  );

  const snapshotMeta = (
    state: State,
    explicit?: RuntimeSnapshotMetadata,
  ): RuntimeSnapshotMetadata => {
    const metadata = input.codec.snapshotMetadata(state);
    if (explicit) {
      if (
        explicit.schemaVersion !== input.stateSchemaVersion ||
        metadata.schemaVersion !== input.stateSchemaVersion ||
        explicit.stateRevision !== metadata.stateRevision
      ) {
        throw new SqliteRuntimeFormatMismatchError(explicit.schemaVersion, input.formatEpoch);
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

  const encode = (
    state: State,
    explicit?: RuntimeSnapshotMetadata,
  ): { json: string; metadata: RuntimeSnapshotMetadata } => {
    const json = input.codec.encodeState(state);
    const derived = snapshotMeta(state, explicit);
    return {
      json,
      metadata: { ...derived, stateChecksum: derived.stateChecksum || checksum(json) },
    };
  };

  const persist = (
    sessionId: string,
    json: string,
    eventPosition: number,
    stateRevision: number,
    _stateChecksum: string,
    schemaVersion: number,
  ): void => {
    upsertSnapshot.run(
      sessionId,
      json,
      eventPosition,
      stateRevision,
      checksum(json),
      schemaVersion,
      input.formatEpoch,
    );
  };

  const validateRestore = (
    state: State,
    sessionId: string,
    row: SnapshotRow | NamedSnapshotRow,
    eventRevision: number,
  ): void => {
    input.codec.validateSnapshot?.({
      state,
      sessionId,
      eventPosition: row.event_position,
      stateRevision: row.state_revision,
      schemaVersion: row.schema_version,
      eventRevision,
    });
  };

  const loadRecord = <T = State>(
    sessionId: string,
  ): { state: T; metadata: RuntimeSnapshotMetadata } | null => {
    if (input.isClosed()) return null;
    const row = selectSnapshot.get(sessionId);
    if (!row) {
      if (input.hasSessionMetadata(sessionId)) {
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
        state: input.codec.decodeState<T>(row.state_json),
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

  return Object.freeze({
    encode,
    persist,
    validateRestore,
    loadRecord,
    getRollingRow: (sessionId: string) => selectSnapshot.get(sessionId),
    getRevision: (sessionId: string) =>
      selectSnapshotRevision.get(sessionId)?.state_revision ?? null,
    save: (sessionId: string, state: State) => {
      if (input.isClosed()) return;
      const encoded = encode(state);
      input.ensureSession(sessionId, state);
      persist(
        sessionId,
        encoded.json,
        input.lastEventPosition(sessionId),
        encoded.metadata.stateRevision,
        encoded.metadata.stateChecksum,
        encoded.metadata.schemaVersion,
      );
    },
  });
}
