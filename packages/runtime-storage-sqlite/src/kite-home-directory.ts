import type { Database } from 'bun:sqlite';
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
}

export interface KiteHomeDirectoryQueryOptions {
  readonly maxWorkspaces?: number;
  readonly maxSessionsPerWorkspace?: number;
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
  assertKiteHomeStoreSchema(database);
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
    `SELECT s.session_id, s.name, s.updated_at,
            COALESCE(MAX(e.sequence), 0) AS last_sequence
       FROM runtime_sessions AS s
       LEFT JOIN runtime_events AS e ON e.session_id = s.session_id
      WHERE s.workspace_id = ?
      GROUP BY s.session_id, s.name, s.updated_at
      ORDER BY s.updated_at DESC, s.session_id ASC
      LIMIT ?`,
  );

  return Object.freeze({
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
