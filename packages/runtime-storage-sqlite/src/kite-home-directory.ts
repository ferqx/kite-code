import type { Database } from 'bun:sqlite';
import {
  assertListRuntimeLogSessionsRequest,
  type ListRuntimeLogSessionsRequest,
  type RuntimeLogSessionPage,
} from '@kite-ai/runtime-host/storage';
import { assertKiteHomeStoreSchema } from './kite-home-store';

export interface KiteHomeDirectorySession {
  readonly sessionId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
}

export interface KiteHomeDirectoryWorkspace {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly sessions: readonly KiteHomeDirectorySession[];
}

export interface KiteHomeDirectoryQueryPort {
  /** Path-free projection from the current Store 9 transaction authority. */
  list(): readonly KiteHomeDirectoryWorkspace[];
  /** Keyset-paged metadata from the same Store, without restoring Runtime projections. */
  listSessions(request: ListRuntimeLogSessionsRequest): RuntimeLogSessionPage;
}

export interface KiteHomeDirectoryQueryOptions {
  readonly maxWorkspaces?: number;
  readonly maxSessionsPerWorkspace?: number;
  readonly assertStoreSchema?: (database: Database) => void;
}

const DEFAULT_MAX_WORKSPACES = 256;
const DEFAULT_MAX_SESSIONS_PER_WORKSPACE = 256;

/**
 * Query the single Store directly; there is no Catalog mirror, outbox cursor, Worker discovery,
 * compatibility reader, or second connection. Canonical paths are deliberately absent from the
 * selected columns and returned types.
 */
export function createKiteHomeDirectoryQuery(
  database: Database,
  options: KiteHomeDirectoryQueryOptions = {},
): KiteHomeDirectoryQueryPort {
  (options.assertStoreSchema ?? assertKiteHomeStoreSchema)(database);
  const maxWorkspaces = positiveBound(
    options.maxWorkspaces,
    DEFAULT_MAX_WORKSPACES,
    'maxWorkspaces',
  );
  const maxSessionsPerWorkspace = positiveBound(
    options.maxSessionsPerWorkspace,
    DEFAULT_MAX_SESSIONS_PER_WORKSPACE,
    'maxSessionsPerWorkspace',
  );
  const listWorkspaces = database.query<{ workspace_id: string; display_name: string }, [number]>(
    `SELECT workspace_id, display_name
       FROM workspaces
      ORDER BY display_name ASC, workspace_id ASC
      LIMIT ?`,
  );
  const listSessions = database.query<
    {
      session_id: string;
      name: string;
      updated_at: number;
      last_sequence: number;
    },
    [string, number]
  >(
    `SELECT s.session_id,
            COALESCE(
              NULLIF(s.name, ''),
              (
                SELECT CASE
                         WHEN json_type(first_event.event_json, '$.content') = 'text'
                           THEN json_extract(first_event.event_json, '$.content')
                         ELSE ''
                       END
                  FROM runtime_events AS first_event
                 WHERE first_event.session_id = s.session_id
                   AND json_extract(first_event.event_json, '$.type') = 'user.message_appended'
                 ORDER BY first_event.sequence ASC
                 LIMIT 1
              ),
              ''
            ) AS name,
            s.updated_at,
            COALESCE(MAX(e.sequence), 0) AS last_sequence
       FROM runtime_sessions AS s
       LEFT JOIN runtime_events AS e ON e.session_id = s.session_id
      WHERE s.workspace_id = ?
      GROUP BY s.session_id, s.name, s.updated_at
      ORDER BY s.updated_at DESC, s.session_id ASC
      LIMIT ?`,
  );

  return Object.freeze({
    listSessions(request: ListRuntimeLogSessionsRequest): RuntimeLogSessionPage {
      assertListRuntimeLogSessionsRequest(request);
      const filters: string[] = [];
      const values: (string | number)[] = [];
      if (request.workspaceDigest) {
        filters.push('s.workspace_digest = ?');
        values.push(request.workspaceDigest);
      }
      if (request.cursor) {
        filters.push('(s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))');
        values.push(request.cursor.updatedAt, request.cursor.updatedAt, request.cursor.sessionId);
      }
      if (request.query?.trim()) {
        filters.push("s.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
        values.push(`%${request.query.trim().replace(/[\\%_]/gu, '\\$&')}%`);
      }
      values.push(request.limit + 1);
      const rows = database
        .query<
          {
            session_id: string;
            name: string;
            needs_smart_name: number;
            updated_at: number;
            last_sequence: number;
            model_provider: string | null;
            model_name: string | null;
            workspace_id: string;
            workspace_digest: string;
            display_name: string;
          },
          (string | number)[]
        >(`
        SELECT s.session_id,
          substr(COALESCE(NULLIF(s.name, ''), (
            SELECT CASE WHEN json_type(e.event_json, '$.content') = 'text'
              THEN json_extract(e.event_json, '$.content') ELSE '' END
            FROM runtime_events e WHERE e.session_id = s.session_id
              AND json_extract(e.event_json, '$.type') = 'user.message_appended'
            ORDER BY e.sequence ASC LIMIT 1
          ), ''), 1, 256) AS name,
          (s.name = '') AS needs_smart_name,
          s.updated_at,
          COALESCE((SELECT MAX(e.sequence) FROM runtime_events e
            WHERE e.session_id = s.session_id), 0) AS last_sequence,
          s.model_provider, s.model_name,
          w.workspace_id, w.workspace_digest, w.display_name
        FROM runtime_sessions s JOIN workspaces w ON w.workspace_id = s.workspace_id
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY s.updated_at DESC, s.session_id DESC LIMIT ?
      `)
        .all(...values);
      const entries = rows.slice(0, request.limit).map((row) => ({
        sessionId: row.session_id,
        displayName: row.name || '新会话',
        needsSmartName: !!row.needs_smart_name,
        updatedAt: row.updated_at,
        lastSequence: row.last_sequence,
        ...(row.model_provider && row.model_name
          ? { model: { provider: row.model_provider, name: row.model_name } }
          : {}),
        workspace: {
          workspaceId: row.workspace_id,
          workspaceDigest: row.workspace_digest,
          displayName: row.display_name,
        },
      }));
      const hasMore = rows.length > request.limit;
      const last = entries.at(-1);
      return {
        entries,
        hasMore,
        ...(hasMore && last
          ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } }
          : {}),
      };
    },
    list() {
      return Object.freeze(
        listWorkspaces.all(maxWorkspaces).map((workspace) =>
          Object.freeze({
            workspaceId: workspace.workspace_id,
            displayName: workspace.display_name,
            sessions: Object.freeze(
              listSessions.all(workspace.workspace_id, maxSessionsPerWorkspace).map((session) =>
                Object.freeze({
                  sessionId: session.session_id,
                  name: session.name,
                  updatedAt: session.updated_at,
                  lastSequence: session.last_sequence,
                }),
              ),
            ),
          }),
        ),
      );
    },
  });
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new RangeError(`${label} must be a positive integer no greater than ${fallback}.`);
  }
  return selected;
}
