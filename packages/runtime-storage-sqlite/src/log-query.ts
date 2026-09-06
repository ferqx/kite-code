import type { Database } from 'bun:sqlite';
import type {
  RuntimeLogEventQuery,
  RuntimeLogEventReadPage,
  RuntimeLogQueryErrorCode,
  RuntimeLogQueryPort,
  RuntimeLogSessionQuery,
  RuntimeLogSessionReadPage,
  RuntimeSnapshotCodec,
} from '@kite-ai/runtime-host/storage';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  RuntimeLogRequestValidationError,
} from '@kite-ai/runtime-host/storage';
import { openSqliteRuntimeLogConnection } from './connection';
import {
  assertSqliteRuntimeRunStoreActive,
  assertSqliteWorkspaceStoreActive,
  resolveSqliteWorkspaceStorePath,
  type SqliteRuntimeLayoutPaths,
} from './layout';
import {
  assertCurrentSqliteRuntimeStoreConnection,
  assertNoFollowDatabasePath,
  assertSqliteRuntimeStorageCanOpen,
  assertWorkspaceSqliteRuntimeStoreConnection,
  openSqliteReadonlySnapshotView,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';
import { assertSqliteRuntimeRunStoreConnection } from './run-store';

export class SqliteRuntimeLogQueryError extends Error {
  readonly code: RuntimeLogQueryErrorCode;

  constructor(code: RuntimeLogQueryErrorCode, message: string) {
    super(message);
    this.name = 'SqliteRuntimeLogQueryError';
    this.code = code;
  }
}

export interface SqliteRuntimeLogQueryInput<Event = unknown, State = unknown> {
  readonly databasePath: string;
  /** The current Host-owned event/state codec; no compatibility decoder is accepted. */
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>;
  /** The current RuntimeEvent discriminant set, supplied by the composition boundary. */
  readonly currentEventTypes: readonly string[];
  /** Optional Store 7/8 scope proof required by an offline Workspace History reader. */
  readonly workspace?: SqliteRuntimeWorkspaceBinding;
  readonly targetStore?: 'run';
}

export interface SqliteWorkspaceRuntimeLogQueryInput<Event = unknown, State = unknown> {
  readonly layout: SqliteRuntimeLayoutPaths;
  readonly layoutGeneration: string;
  readonly workerScopeId: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>;
  readonly currentEventTypes: readonly string[];
  readonly targetStore?: 'run';
}

type EventRow = {
  readonly session_id: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly schema_version: number;
  readonly causation_id: string | null;
  readonly occurred_at: string | null;
  readonly created_at: number;
  readonly event_json: string;
};

function isBusy(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /SQLITE_(BUSY|LOCKED)|database is locked/iu.test(String(error))
  );
}

function queryError(error: unknown): SqliteRuntimeLogQueryError {
  if (error instanceof SqliteRuntimeLogQueryError) return error;
  if (error instanceof RuntimeLogRequestValidationError) {
    return new SqliteRuntimeLogQueryError('invalid_request', 'Runtime log request is invalid.');
  }
  if (isBusy(error))
    return new SqliteRuntimeLogQueryError(
      'temporarily_unavailable',
      'Runtime log is temporarily unavailable.',
    );
  if (/malformed JSON/iu.test(String(error))) {
    return new SqliteRuntimeLogQueryError('corrupt_event', 'A durable event could not be decoded.');
  }
  return new SqliteRuntimeLogQueryError('session_unavailable', 'Runtime log is unavailable.');
}

function currentSessionLastSequence(db: Database, sessionId: string): number {
  const session = db
    .query<{ session_id: string }, [string]>(
      'SELECT session_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    )
    .get(sessionId);
  if (!session)
    throw new SqliteRuntimeLogQueryError('session_not_found', 'Runtime session was not found.');
  return (
    db
      .query<{ sequence: number | null }, [string]>(
        'SELECT MAX(sequence) AS sequence FROM runtime_events WHERE session_id = ?',
      )
      .get(sessionId)?.sequence ?? 0
  );
}

function pageEventRow<Event>(
  row: EventRow,
  codec: RuntimeSnapshotCodec<Event, unknown>,
  currentEventTypes: ReadonlySet<string>,
): Event & { readonly type: string } {
  if (row.schema_version !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION) {
    throw new SqliteRuntimeLogQueryError(
      'corrupt_event',
      'A durable event has an incompatible format.',
    );
  }
  let event: Event;
  try {
    event = codec.decodeEvent(row.event_json, { sequence: row.sequence });
  } catch {
    throw new SqliteRuntimeLogQueryError('corrupt_event', 'A durable event could not be decoded.');
  }
  if (
    typeof event !== 'object' ||
    event === null ||
    typeof (event as { type?: unknown }).type !== 'string' ||
    !currentEventTypes.has((event as unknown as { type: string }).type)
  ) {
    throw new SqliteRuntimeLogQueryError(
      'corrupt_event',
      'A durable event has an unknown current type.',
    );
  }
  return event as Event & { readonly type: string };
}

/**
 * Read-only Store query adapter. It performs strict current-format preflight
 * before the reader is opened and only returns decoded events, never event_json.
 */
export function createSqliteRuntimeLogQueryPort<Event = unknown, State = unknown>(
  input: SqliteRuntimeLogQueryInput<Event, State>,
): RuntimeLogQueryPort<Event> {
  if (
    !input.databasePath ||
    input.databasePath === ':memory:' ||
    input.currentEventTypes.length === 0
  ) {
    throw new SqliteRuntimeLogQueryError(
      'session_unavailable',
      'Runtime log reader requires a persistent current-format store.',
    );
  }
  try {
    assertNoFollowDatabasePath(input.databasePath);
    if (input.targetStore === 'run') {
      if (!input.workspace) throw new Error('Store 8 log query requires a Workspace binding.');
    } else {
      assertSqliteRuntimeStorageCanOpen(input.databasePath, undefined, undefined, input.workspace);
    }
  } catch (error) {
    throw queryError(error);
  }
  let db: Database;
  let closeDatabase: () => void;
  try {
    const snapshot = input.workspace
      ? openSqliteReadonlySnapshotView(input.databasePath)
      : undefined;
    const opened = snapshot?.database ?? openSqliteRuntimeLogConnection(input.databasePath);
    try {
      if (input.workspace === undefined) assertCurrentSqliteRuntimeStoreConnection(opened);
      else if (input.targetStore === 'run') {
        assertSqliteRuntimeRunStoreConnection(opened, input.workspace);
      } else assertWorkspaceSqliteRuntimeStoreConnection(opened, input.workspace);
    } catch (error) {
      if (snapshot) snapshot.close();
      else opened.close();
      throw error;
    }
    db = opened;
    closeDatabase = snapshot?.close ?? (() => opened.close());
  } catch (error) {
    throw queryError(error);
  }
  return createSqliteRuntimeLogQueryPortFromDatabase_({
    database: db,
    codec: input.codec,
    currentEventTypes: input.currentEventTypes,
    close: closeDatabase,
  });
}

/**
 * Bind the existing bounded log-query implementation to an already-open Store connection.
 * This is an internal adapter seam for the Store 7/8 owner: it opens no second SQLite connection
 * and its close callback never owns the caller's database unless explicitly supplied.
 */
export function createSqliteRuntimeLogQueryPortFromDatabase_<
  Event = unknown,
  State = unknown,
>(input: {
  readonly database: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State> | RuntimeSnapshotCodec<Event, State>;
  readonly currentEventTypes: readonly string[];
  readonly close?: () => void;
}): RuntimeLogQueryPort<Event> {
  if (input.currentEventTypes.length === 0) {
    throw new SqliteRuntimeLogQueryError(
      'session_unavailable',
      'Runtime log reader requires current event types.',
    );
  }
  const db = input.database;
  const closeDatabase = input.close ?? (() => undefined);
  let closed = false;
  const eventTypes = new Set(input.currentEventTypes);
  const assertOpen = (): void => {
    if (closed)
      throw new SqliteRuntimeLogQueryError('session_unavailable', 'Runtime log reader is closed.');
  };
  const run = <Result>(work: () => Result): Result => {
    assertOpen();
    try {
      return work();
    } catch (error) {
      throw queryError(error);
    }
  };

  return Object.freeze({
    listSessions(request: RuntimeLogSessionQuery): RuntimeLogSessionReadPage {
      return run(() => {
        assertListRuntimeLogSessionsRequest(request);
        const filters: string[] = [];
        const args: (string | number)[] = [];
        if (request.query?.trim()) {
          filters.push("s.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
          args.push(`%${request.query.trim().replace(/[\\%_]/gu, '\\$&')}%`);
        }
        if (request.cursor) {
          filters.push('(s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))');
          args.push(request.cursor.updatedAt, request.cursor.updatedAt, request.cursor.sessionId);
        }
        args.push(request.limit + 1);
        const rows = db
          .query<
            {
              session_id: string;
              name: string;
              updated_at: number;
              model_provider: string | null;
              model_name: string | null;
              last_sequence: number | null;
            },
            (string | number)[]
          >(
            `SELECT s.session_id, s.name, s.updated_at, s.model_provider, s.model_name, (SELECT MAX(e.sequence) FROM runtime_events e WHERE e.session_id = s.session_id) AS last_sequence FROM runtime_sessions s ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY s.updated_at DESC, s.session_id DESC LIMIT ?`,
          )
          .all(...args);
        const hasMore = rows.length > request.limit;
        const entries = rows.slice(0, request.limit).map((row) => ({
          sessionId: row.session_id,
          name: row.name,
          updatedAt: row.updated_at,
          lastSequence: row.last_sequence ?? 0,
          ...(row.model_provider && row.model_name
            ? { model: { provider: row.model_provider, name: row.model_name } }
            : {}),
        }));
        const last = entries.at(-1);
        return {
          entries,
          hasMore,
          ...(hasMore && last
            ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } }
            : {}),
        };
      });
    },
    listEvents(request: RuntimeLogEventQuery): RuntimeLogEventReadPage<Event> {
      return run(() => {
        assertListRuntimeLogEventsRequest(request);
        const requestedTypes = request.eventTypes ? [...new Set(request.eventTypes)] : undefined;
        if (requestedTypes?.some((type) => !eventTypes.has(type))) {
          throw new SqliteRuntimeLogQueryError(
            'invalid_request',
            'eventTypes contains an unknown current RuntimeEvent type.',
          );
        }
        const observedLastSequence = currentSessionLastSequence(db, request.sessionId);
        const filters = ['session_id = ?'];
        const args: (string | number)[] = [request.sessionId];
        if (request.afterSequence !== undefined) {
          filters.push('sequence > ?');
          args.push(request.afterSequence);
        }
        if (request.beforeSequence !== undefined) {
          filters.push('sequence < ?');
          args.push(request.beforeSequence);
        }
        if (requestedTypes?.length) {
          filters.push(
            `json_extract(event_json, '$.type') IN (${requestedTypes.map(() => '?').join(', ')})`,
          );
          args.push(...requestedTypes);
        }
        const descending = request.direction === 'backward';
        args.push(request.limit + 1);
        const rows = db
          .query<EventRow, (string | number)[]>(
            `SELECT session_id, event_id, sequence, schema_version, causation_id, occurred_at, created_at, event_json FROM runtime_events WHERE ${filters.join(' AND ')} ORDER BY sequence ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
          )
          .all(...args);
        const hasMore = rows.length > request.limit;
        const selected = rows.slice(0, request.limit);
        if (descending) selected.reverse();
        const entries = selected.map((row) => ({
          sessionId: row.session_id,
          sequence: row.sequence,
          eventId: row.event_id,
          ...(row.causation_id ? { causationId: row.causation_id } : {}),
          ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
          createdAt: row.created_at,
          event: pageEventRow(row, input.codec, eventTypes),
        }));
        const cursor = descending ? entries.at(0)?.sequence : entries.at(-1)?.sequence;
        return {
          entries,
          hasMore,
          ...(hasMore && cursor !== undefined ? { nextCursor: cursor } : {}),
          observedLastSequence,
        };
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeDatabase();
    },
  });
}

/**
 * Resolve and pin a query-only Store 7/8 reader from active-layout authority.
 * The caller supplies only the opaque Worker scope and the already selected
 * generation; the canonical path and persisted Workspace digest never cross
 * this storage boundary.
 */
export function createSqliteWorkspaceRuntimeLogQueryPort<Event = unknown, State = unknown>(
  input: SqliteWorkspaceRuntimeLogQueryInput<Event, State>,
): RuntimeLogQueryPort<Event> {
  const databasePath = resolveSqliteWorkspaceStorePath(
    input.layout,
    input.layoutGeneration,
    input.workerScopeId,
  );
  let binding: SqliteRuntimeWorkspaceBinding;
  const snapshot = openSqliteReadonlySnapshotView(databasePath);
  try {
    const marker = snapshot.database
      .query<{ value: string }, []>(
        "SELECT value FROM runtime_store_meta WHERE key = 'workspace_identity_digest' LIMIT 1",
      )
      .get();
    if (!marker) {
      throw new SqliteRuntimeLogQueryError(
        'session_unavailable',
        'Runtime log Workspace identity is unavailable.',
      );
    }
    binding = Object.freeze({
      layoutGeneration: input.layoutGeneration,
      workerScopeId: input.workerScopeId,
      workspaceIdentityDigest: marker.value,
    });
    if (input.targetStore === 'run') {
      assertSqliteRuntimeRunStoreConnection(snapshot.database, binding);
    } else {
      assertWorkspaceSqliteRuntimeStoreConnection(snapshot.database, binding);
    }
  } catch (error) {
    throw queryError(error);
  } finally {
    snapshot.close();
  }
  try {
    if (input.targetStore === 'run') {
      assertSqliteRuntimeRunStoreActive(input.layout, binding, databasePath);
    } else {
      assertSqliteWorkspaceStoreActive(input.layout, binding, databasePath);
    }
  } catch (error) {
    throw queryError(error);
  }
  const reader = createSqliteRuntimeLogQueryPort({
    databasePath,
    codec: input.codec,
    currentEventTypes: input.currentEventTypes,
    workspace: binding,
    ...(input.targetStore === 'run' ? { targetStore: 'run' as const } : {}),
  });
  const verifyActive = <Result>(read: () => Result): Result => {
    try {
      if (input.targetStore === 'run') {
        assertSqliteRuntimeRunStoreActive(input.layout, binding, databasePath);
      } else {
        assertSqliteWorkspaceStoreActive(input.layout, binding, databasePath);
      }
      const result = read();
      if (input.targetStore === 'run') {
        assertSqliteRuntimeRunStoreActive(input.layout, binding, databasePath);
      } else {
        assertSqliteWorkspaceStoreActive(input.layout, binding, databasePath);
      }
      return result;
    } catch (error) {
      throw queryError(error);
    }
  };
  return Object.freeze({
    listSessions: (request: RuntimeLogSessionQuery) =>
      verifyActive(() => reader.listSessions(request)),
    listEvents: (request: RuntimeLogEventQuery) => verifyActive(() => reader.listEvents(request)),
    close: () => reader.close(),
  });
}
