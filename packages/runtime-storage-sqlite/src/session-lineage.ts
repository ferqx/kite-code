import type { Database } from 'bun:sqlite';

/** Store 9/10 remain readable; only the private Store 11 candidate has lineage. */
export function hasSessionLineage(database: Database): boolean {
  return database
    .query<{ name: string }, []>('PRAGMA table_info(runtime_sessions)')
    .all()
    .some((column) => column.name === 'parent_session_id');
}

export interface DirectChildSessionRecord {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface DirectChildSessionCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

/** A parent ID is authority only for its immediate children, never for a root or sibling. */
export function readDirectChildSession(
  database: Database,
  parentSessionId: string,
  childSessionId: string,
): DirectChildSessionRecord | null {
  if (!hasSessionLineage(database) || !parentSessionId || !childSessionId) return null;
  const row = database
    .query<
      {
        session_id: string;
        parent_session_id: string;
        name: string;
        updated_at: number;
        revision: number;
      },
      [string, string]
    >(`SELECT c.session_id,c.parent_session_id,c.name,c.updated_at,c.revision
      FROM runtime_sessions c JOIN runtime_sessions p ON p.session_id=c.parent_session_id
      WHERE c.session_id=? AND p.session_id=? LIMIT 1`)
    .get(childSessionId, parentSessionId);
  return row
    ? {
        sessionId: row.session_id,
        parentSessionId: row.parent_session_id,
        name: row.name,
        updatedAt: row.updated_at,
        revision: row.revision,
      }
    : null;
}

export function listDirectChildSessions(
  database: Database,
  parentSessionId: string,
  limit: number,
  cursor?: DirectChildSessionCursor,
): {
  readonly entries: readonly DirectChildSessionRecord[];
  readonly nextCursor?: DirectChildSessionCursor;
} {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && (!Number.isSafeInteger(cursor.updatedAt) || !cursor.sessionId))
  )
    throw new Error('Direct child Session page request is invalid.');
  if (!hasSessionLineage(database) || !parentSessionId) return { entries: [] };
  const rows = database
    .query<
      {
        session_id: string;
        parent_session_id: string;
        name: string;
        updated_at: number;
        revision: number;
      },
      (string | number)[]
    >(`SELECT c.session_id,c.parent_session_id,c.name,c.updated_at,c.revision
      FROM runtime_sessions c JOIN runtime_sessions p ON p.session_id=c.parent_session_id
      WHERE p.session_id=?${cursor ? ' AND (c.updated_at < ? OR (c.updated_at = ? AND c.session_id < ?))' : ''}
      ORDER BY c.updated_at DESC,c.session_id DESC LIMIT ?`)
    .all(
      parentSessionId,
      ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.sessionId] : []),
      limit + 1,
    );
  const entries = rows.slice(0, limit).map((row) => ({
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    updatedAt: row.updated_at,
    revision: row.revision,
  }));
  const last = entries.at(-1);
  return {
    entries,
    ...(rows.length > limit && last
      ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } }
      : {}),
  };
}
