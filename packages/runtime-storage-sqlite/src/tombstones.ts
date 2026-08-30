import type { Database } from 'bun:sqlite';
import {
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SqliteRuntimeFormatMismatchError,
  type SqliteRuntimeSessionBinding,
} from './preflight';

export interface SqliteRuntimeWorkspaceTombstone extends SqliteRuntimeSessionBinding {
  readonly sessionId: string;
  readonly deletedRevision: number;
  readonly deletedAt: number;
}

export interface SqliteRuntimeWorkspaceTombstoneStore {
  write(tombstone: SqliteRuntimeWorkspaceTombstone): void;
  read(sessionId: string): SqliteRuntimeWorkspaceTombstone | null;
}

/** Store 7's retained deleted-session ownership fact. */
export function createSqliteWorkspaceTombstoneStore(
  db: Database,
  beforeWrite?: () => void,
): SqliteRuntimeWorkspaceTombstoneStore {
  const insert = db.query(
    `INSERT INTO session_workspace_tombstone (
      session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const select = db.query<
    {
      session_id: string;
      worker_scope_id: string;
      project_id: string;
      workspace_digest: string;
      deleted_revision: number;
      deleted_at: number;
    },
    [string]
  >(
    'SELECT session_id, worker_scope_id, project_id, workspace_digest, deleted_revision, deleted_at FROM session_workspace_tombstone WHERE session_id = ? LIMIT 1',
  );
  return Object.freeze({
    write: (tombstone: SqliteRuntimeWorkspaceTombstone): void => {
      if (
        !tombstone.sessionId ||
        !tombstone.workerScopeId ||
        !tombstone.projectId ||
        !tombstone.workspaceDigest ||
        !Number.isSafeInteger(tombstone.deletedRevision) ||
        tombstone.deletedRevision < 0 ||
        !Number.isSafeInteger(tombstone.deletedAt) ||
        tombstone.deletedAt < 0
      ) {
        throw new SqliteRuntimeFormatMismatchError(
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        );
      }
      beforeWrite?.();
      insert.run(
        tombstone.sessionId,
        tombstone.workerScopeId,
        tombstone.projectId,
        tombstone.workspaceDigest,
        tombstone.deletedRevision,
        tombstone.deletedAt,
      );
    },
    read: (sessionId: string): SqliteRuntimeWorkspaceTombstone | null => {
      if (!sessionId) return null;
      const row = select.get(sessionId);
      return row
        ? {
            sessionId: row.session_id,
            workerScopeId: row.worker_scope_id,
            projectId: row.project_id,
            workspaceDigest: row.workspace_digest,
            deletedRevision: row.deleted_revision,
            deletedAt: row.deleted_at,
          }
        : null;
    },
  });
}
