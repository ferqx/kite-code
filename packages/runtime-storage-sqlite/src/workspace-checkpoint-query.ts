import type { Database } from 'bun:sqlite';
import {
  assertSqliteRuntimeWorkspaceBinding,
  checksum,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

export const SQLITE_WORKSPACE_CHECKPOINT_MAX_PAGE_SIZE = 200 as const;

export interface SqliteWorkspaceCheckpointCursor {
  readonly revision: number;
  readonly checkpointId: string;
}

export interface SqliteWorkspaceCheckpointEntry {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly eventPosition: number;
  /** SQLite seconds since Unix epoch. */
  readonly createdAt: number;
  readonly affectedFileCount: number;
}

export interface SqliteWorkspaceCheckpointPage {
  readonly entries: readonly SqliteWorkspaceCheckpointEntry[];
  readonly nextCursor?: SqliteWorkspaceCheckpointCursor;
  readonly hasMore: boolean;
}

/** Store 7-only, same-connection Checkpoint metadata page source. */
export interface SqliteWorkspaceCheckpointQuery {
  list(input: {
    readonly sessionId: string;
    readonly cursor?: SqliteWorkspaceCheckpointCursor;
    readonly limit?: number;
  }): SqliteWorkspaceCheckpointPage;
  get(sessionId: string, checkpointId: string): SqliteWorkspaceCheckpointEntry | undefined;
}

interface CheckpointRow {
  readonly name: string;
  readonly revision: number;
  readonly event_position: number;
  readonly created_at: number;
  readonly affected_file_count: number;
}

interface SnapshotIntegrityRow {
  readonly state_json: string;
  readonly state_checksum: string;
  readonly schema_version: number;
  readonly format_epoch: string;
}

/**
 * Bind a bounded Checkpoint page reader to the Worker's already-open Store 7 database. It opens
 * no connection, creates no schema/index, returns no State JSON, and validates one selected
 * snapshot at a time before publishing its metadata.
 */
export function createSqliteWorkspaceCheckpointQuery(input: {
  readonly db: Database;
  readonly binding: SqliteRuntimeWorkspaceBinding;
}): SqliteWorkspaceCheckpointQuery {
  assertSqliteRuntimeWorkspaceBinding(input.binding);
  const integrity = input.db.query<SnapshotIntegrityRow, [string, string]>(
    `SELECT state_json, state_checksum, schema_version, format_epoch
       FROM runtime_named_snapshots
      WHERE session_id = ? AND name = ?
      LIMIT 1`,
  );
  const exact = input.db.query<CheckpointRow, [string, string]>(
    `SELECT s.name, s.revision, s.event_position, s.created_at,
            (SELECT COUNT(DISTINCT p.path)
               FROM runtime_file_preimages p
              WHERE p.session_id = s.session_id AND p.event_position > s.event_position)
              AS affected_file_count
       FROM runtime_named_snapshots s
      WHERE s.session_id = ? AND s.name = ?
      LIMIT 1`,
  );

  const validateSnapshot = (sessionId: string, checkpointId: string): void => {
    const row = integrity.get(sessionId, checkpointId);
    if (
      !row ||
      row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
      row.format_epoch !== SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH ||
      checksum(row.state_json) !== row.state_checksum
    ) {
      throw new Error('Workspace Checkpoint snapshot is unavailable.');
    }
  };
  const decode = (sessionId: string, row: CheckpointRow): SqliteWorkspaceCheckpointEntry => {
    if (
      !safeIdentity(sessionId) ||
      !safeIdentity(row.name) ||
      !safeRevision(row.revision) ||
      !safeRevision(row.event_position) ||
      !safeRevision(row.created_at) ||
      !safeRevision(row.affected_file_count)
    ) {
      throw new Error('Workspace Checkpoint metadata is invalid.');
    }
    validateSnapshot(sessionId, row.name);
    return Object.freeze({
      checkpointId: row.name,
      sessionId,
      revision: row.revision,
      eventPosition: row.event_position,
      createdAt: row.created_at,
      affectedFileCount: row.affected_file_count,
    });
  };

  return Object.freeze({
    list(request: {
      readonly sessionId: string;
      readonly cursor?: SqliteWorkspaceCheckpointCursor;
      readonly limit?: number;
    }) {
      assertIdentity(request.sessionId, 'Session');
      const limit = request.limit ?? SQLITE_WORKSPACE_CHECKPOINT_MAX_PAGE_SIZE;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > SQLITE_WORKSPACE_CHECKPOINT_MAX_PAGE_SIZE
      ) {
        throw new RangeError('Workspace Checkpoint page limit is invalid.');
      }
      if (request.cursor) {
        if (!safeRevision(request.cursor.revision)) {
          throw new TypeError('Workspace Checkpoint cursor revision is invalid.');
        }
        assertIdentity(request.cursor.checkpointId, 'Checkpoint cursor');
      }
      const filters = ['s.session_id = ?'];
      const args: (string | number)[] = [request.sessionId];
      if (request.cursor) {
        filters.push('(s.revision > ? OR (s.revision = ? AND s.name > ?))');
        args.push(request.cursor.revision, request.cursor.revision, request.cursor.checkpointId);
      }
      args.push(limit + 1);
      const rows = input.db
        .query<CheckpointRow, (string | number)[]>(
          `SELECT s.name, s.revision, s.event_position, s.created_at,
                  (SELECT COUNT(DISTINCT p.path)
                     FROM runtime_file_preimages p
                    WHERE p.session_id = s.session_id AND p.event_position > s.event_position)
                    AS affected_file_count
             FROM runtime_named_snapshots s
            WHERE ${filters.join(' AND ')}
            ORDER BY s.revision ASC, s.name ASC
            LIMIT ?`,
        )
        .all(...args);
      const hasMore = rows.length > limit;
      const entries = rows.slice(0, limit).map((row) => decode(request.sessionId, row));
      const last = entries.at(-1);
      return Object.freeze({
        entries: Object.freeze(entries),
        ...(hasMore && last
          ? {
              nextCursor: Object.freeze({
                revision: last.revision,
                checkpointId: last.checkpointId,
              }),
            }
          : {}),
        hasMore,
      });
    },
    get(sessionId: string, checkpointId: string) {
      assertIdentity(sessionId, 'Session');
      assertIdentity(checkpointId, 'Checkpoint');
      const row = exact.get(sessionId, checkpointId);
      return row ? decode(sessionId, row) : undefined;
    },
  });
}

function safeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeIdentity(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function assertIdentity(value: string, label: string): void {
  if (!safeIdentity(value)) throw new TypeError(`${label} identity is invalid.`);
}
