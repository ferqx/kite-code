import type { Database } from 'bun:sqlite';
import {
  createSqliteWorkspaceAuthorityForConnection_,
  inspectSqliteWorkspaceAuthorityMetadataKey,
  type SqliteWorkspaceAuthority,
} from './authority';
import { assertKiteHomeStoreSchema, KITE_HOME_STORE_FORMAT_EPOCH } from './kite-home-store';
import type { KiteHomeWorkspaceAdmission } from './kite-home-workspaces';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';

/** Store 9 namespace adapter for the existing strict Controller/effect/resource authority codec. */
export function createKiteHomeWorkspaceAuthority(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly workspace: KiteHomeWorkspaceAdmission;
  readonly nowMs?: () => number;
}): SqliteWorkspaceAuthority {
  const binding = {
    layoutGeneration: KITE_HOME_STORE_FORMAT_EPOCH,
    workerScopeId: input.workspace.workspaceId,
    workspaceIdentityDigest: input.workspace.workspaceIdentityDigest,
  } as const;
  const assertConnection = (): void => {
    assertKiteHomeStoreSchema(input.database);
    const row = input.database
      .query<{ workspace_identity_digest: string }, [string]>(
        'SELECT workspace_identity_digest FROM workspaces WHERE workspace_id = ? LIMIT 1',
      )
      .get(input.workspace.workspaceId);
    if (row?.workspace_identity_digest !== input.workspace.workspaceIdentityDigest) {
      throw new Error('Kite Home Workspace authority binding is unavailable.');
    }
  };
  return createSqliteWorkspaceAuthorityForConnection_({
    db: input.database,
    binding,
    assertConnection,
    runTransaction: (work) => input.writer.run(work),
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
        .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key = ? LIMIT 1')
        .get(key);
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        throw new Error('Kite Home Workspace authority metadata is malformed.');
      }
    },
    writeMetadata(key, value) {
      input.database
        .query('INSERT OR REPLACE INTO kite_meta (key, value) VALUES (?, ?)')
        .run(key, JSON.stringify(value));
    },
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
  });
}

/** Remove every exact Controller/effect/resource key for one deleted Store 9 Session. */
export function removeKiteHomeWorkspaceAuthoritySessionInTransaction(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly workspaceId: string;
  readonly sessionId: string;
}): void {
  if (!input.writer.inTransaction) {
    throw new Error('Kite Home Workspace authority cleanup requires the Store writer transaction.');
  }
  const namespace = `workspace_authority/${input.workspaceId}/`;
  const prefix = `${namespace}workspace_authority_v1:`;
  const rows = input.database
    .query<{ key: string }, [number, string]>(
      'SELECT key FROM kite_meta WHERE substr(key, 1, ?) = ? ORDER BY key',
    )
    .all(prefix.length, prefix);
  const remove = input.database.query('DELETE FROM kite_meta WHERE key = ?');
  for (const row of rows) {
    const inspected = inspectSqliteWorkspaceAuthorityMetadataKey(row.key.slice(namespace.length));
    if (inspected.sessionId === input.sessionId) remove.run(row.key);
  }
}
