import type { Database } from 'bun:sqlite';
import type { RuntimeSessionModelRoute } from '@kite/runtime-host/storage';
import {
  SqliteRuntimeFormatMismatchError,
  type SqliteRuntimeSnapshotCodec,
  SqliteRuntimeStorageOpenError,
} from './preflight';

/** Session metadata persistence over the adapter's one database connection. */
export function createSqliteSessionMetadataStore<State>(input: {
  readonly db: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<unknown, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
}) {
  const upsertSession = input.db.query(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, workspace_digest = excluded.workspace_digest, state_schema = excluded.state_schema, format_epoch = excluded.format_epoch, revision = excluded.revision, updated_at = unixepoch()',
  );
  const updateSessionName = input.db.query(
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
  const selectIdentity = input.db.query<{ project_id: string; workspace_digest: string }, [string]>(
    'SELECT project_id, workspace_digest FROM runtime_sessions WHERE session_id = ?',
  );
  const deleteSession = input.db.query('DELETE FROM runtime_sessions WHERE session_id = ?');

  const ensureSession = (sessionId: string, state?: State): void => {
    const identity = state ? input.codec.sessionIdentity?.(state) : undefined;
    const existing = selectIdentity.get(sessionId);
    if (!identity) {
      if (existing) return;
      throw new SqliteRuntimeStorageOpenError(
        `Store session ${sessionId} has no State project identity.`,
      );
    }
    if (
      existing &&
      (existing.project_id !== identity.projectId ||
        existing.workspace_digest !== identity.canonicalWorkspaceDigest)
    ) {
      throw new SqliteRuntimeFormatMismatchError(input.stateSchemaVersion, input.formatEpoch);
    }
    upsertSession.run(
      sessionId,
      identity.projectId,
      identity.canonicalWorkspaceDigest,
      input.stateSchemaVersion,
      input.formatEpoch,
      state ? input.codec.snapshotMetadata(state).stateRevision : 0,
    );
  };

  return Object.freeze({
    ensureSession,
    list: (limit: number) => listSessions.all(limit),
    setName: (sessionId: string, name: string) => updateSessionName.run(name, sessionId),
    hasMetadata: (sessionId: string) => selectSessionModelRoute.get(sessionId) != null,
    getModelRoute: (sessionId: string): RuntimeSessionModelRoute | null => {
      const row = selectSessionModelRoute.get(sessionId);
      return row?.model_provider && row.model_name
        ? { provider: row.model_provider, name: row.model_name }
        : null;
    },
    setModelRoute: (sessionId: string, route: RuntimeSessionModelRoute) =>
      updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), sessionId),
    delete: (sessionId: string) => deleteSession.run(sessionId),
  });
}
