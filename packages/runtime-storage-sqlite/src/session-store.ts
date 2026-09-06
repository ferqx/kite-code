import type { Database } from 'bun:sqlite';
import type { RuntimeSessionModelRoute } from '@kite-ai/runtime-host/storage';
import type { SqliteWorkspaceDirectoryOutboxEntry } from './directory-outbox';
import {
  SqliteRuntimeFormatMismatchError,
  type SqliteRuntimeSnapshotCodec,
  SqliteRuntimeStorageOpenError,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

/** Session metadata persistence over the adapter's one database connection. */
export function createSqliteSessionMetadataStore<State>(input: {
  readonly db: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<unknown, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly workspaceBinding?: SqliteRuntimeWorkspaceBinding;
  readonly beforeWrite?: () => void;
  readonly onDirectoryChange?: (entry: SqliteWorkspaceDirectoryOutboxEntry) => void;
}) {
  const upsertSession = input.workspaceBinding
    ? input.db.query(
        'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, workspace_digest = excluded.workspace_digest, worker_scope_id = excluded.worker_scope_id, workspace_identity_digest = excluded.workspace_identity_digest, state_schema = excluded.state_schema, format_epoch = excluded.format_epoch, revision = excluded.revision, updated_at = excluded.updated_at',
      )
    : input.db.query(
        'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, workspace_digest = excluded.workspace_digest, state_schema = excluded.state_schema, format_epoch = excluded.format_epoch, revision = excluded.revision, updated_at = unixepoch()',
      );
  const updateSessionName = input.workspaceBinding
    ? input.db.query('UPDATE runtime_sessions SET name = ?, updated_at = ? WHERE session_id = ?')
    : input.db.query(
        'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE session_id = ?',
      );
  const selectSessionModelRoute = input.db.query<
    { model_provider: string | null; model_name: string | null },
    [string]
  >('SELECT model_provider, model_name FROM runtime_sessions WHERE session_id = ?');
  const updateSessionModelRoute = input.db.query(
    'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE session_id = ?',
  );
  const listSessions = input.db.query<
    { thread_id: string; name: string; updated_at: number },
    [number]
  >(
    'SELECT session_id AS thread_id, name, updated_at FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?',
  );
  const selectIdentity = input.workspaceBinding
    ? input.db.query<
        {
          project_id: string;
          workspace_digest: string;
          worker_scope_id: string;
          workspace_identity_digest: string;
        },
        [string]
      >(
        'SELECT project_id, workspace_digest, worker_scope_id, workspace_identity_digest FROM runtime_sessions WHERE session_id = ?',
      )
    : input.db.query<
        {
          project_id: string;
          workspace_digest: string;
          worker_scope_id?: string;
          workspace_identity_digest?: string;
        },
        [string]
      >('SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?');
  const selectTombstone = input.workspaceBinding
    ? input.db.query<{ session_id: string }, [string]>(
        'SELECT session_id FROM session_workspace_tombstone WHERE session_id = ? LIMIT 1',
      )
    : undefined;
  const selectDirectoryEntry = input.workspaceBinding
    ? input.db.query<{ revision: number; updated_at: number }, [string]>(
        'SELECT revision, updated_at FROM runtime_sessions WHERE session_id = ?',
      )
    : undefined;
  const deleteSession = input.db.query('DELETE FROM runtime_sessions WHERE session_id = ?');

  const ensureSession = (sessionId: string, state?: State): void => {
    const identity = state ? input.codec.sessionIdentity?.(state) : undefined;
    const existing = selectIdentity.get(sessionId);
    if (!existing && selectTombstone?.get(sessionId)) {
      throw new SqliteRuntimeFormatMismatchError(input.stateSchemaVersion, input.formatEpoch);
    }
    if (!identity) {
      if (existing) return;
      throw new SqliteRuntimeStorageOpenError(
        `Store session ${sessionId} has no State project identity.`,
      );
    }
    if (
      existing &&
      (existing.project_id !== identity.projectId ||
        existing.workspace_digest !== identity.canonicalWorkspaceDigest ||
        (input.workspaceBinding !== undefined &&
          (existing.worker_scope_id !== input.workspaceBinding.workerScopeId ||
            existing.workspace_identity_digest !== input.workspaceBinding.workspaceIdentityDigest)))
    ) {
      throw new SqliteRuntimeFormatMismatchError(input.stateSchemaVersion, input.formatEpoch);
    }
    if (input.workspaceBinding) {
      input.beforeWrite?.();
      const updatedAt = nextUpdatedAt(sessionId);
      upsertSession.run(
        sessionId,
        identity.projectId,
        identity.canonicalWorkspaceDigest,
        input.workspaceBinding.workerScopeId,
        input.workspaceBinding.workspaceIdentityDigest,
        input.stateSchemaVersion,
        input.formatEpoch,
        state ? input.codec.snapshotMetadata(state).stateRevision : 0,
        updatedAt,
      );
      appendDirectoryChange(sessionId, false);
    } else {
      input.beforeWrite?.();
      upsertSession.run(
        sessionId,
        identity.projectId,
        identity.canonicalWorkspaceDigest,
        input.stateSchemaVersion,
        input.formatEpoch,
        state ? input.codec.snapshotMetadata(state).stateRevision : 0,
      );
      appendDirectoryChange(sessionId, false);
    }
  };

  const appendDirectoryChange = (sessionId: string, tombstone: boolean): void => {
    if (!input.workspaceBinding || !input.onDirectoryChange) return;
    const row = selectDirectoryEntry?.get(sessionId);
    if (!row) return;
    input.onDirectoryChange({
      sessionId,
      workerScopeId: input.workspaceBinding.workerScopeId,
      revision: row.revision,
      updatedAt: row.updated_at,
      tombstone,
    });
  };

  const nextUpdatedAt = (sessionId: string): number => {
    const previous = selectDirectoryEntry?.get(sessionId)?.updated_at ?? 0;
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Session clock is invalid.');
    return Math.max(now, previous + 1);
  };

  return Object.freeze({
    ensureSession,
    list: (limit: number) => listSessions.all(limit),
    setName: (sessionId: string, name: string) => {
      input.beforeWrite?.();
      const result = input.workspaceBinding
        ? updateSessionName.run(name, nextUpdatedAt(sessionId), sessionId)
        : updateSessionName.run(name, sessionId);
      appendDirectoryChange(sessionId, false);
      return result;
    },
    hasMetadata: (sessionId: string) => selectSessionModelRoute.get(sessionId) != null,
    getModelRoute: (sessionId: string): RuntimeSessionModelRoute | null => {
      const row = selectSessionModelRoute.get(sessionId);
      return row?.model_provider && row.model_name
        ? { provider: row.model_provider, name: row.model_name }
        : null;
    },
    setModelRoute: (sessionId: string, route: RuntimeSessionModelRoute) => {
      input.beforeWrite?.();
      return updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), sessionId);
    },
    delete: (sessionId: string) => {
      input.beforeWrite?.();
      const updatedAt = nextUpdatedAt(sessionId);
      const row = selectDirectoryEntry?.get(sessionId);
      if (row && input.workspaceBinding && input.onDirectoryChange) {
        input.onDirectoryChange({
          sessionId,
          workerScopeId: input.workspaceBinding.workerScopeId,
          revision: row.revision,
          updatedAt,
          tombstone: true,
        });
      }
      return deleteSession.run(sessionId);
    },
  });
}
