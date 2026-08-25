import type { Database } from 'bun:sqlite';
import type {
  RuntimeLogEventQuery,
  RuntimeLogEventReadPage,
  RuntimeLogQueryErrorCode,
  RuntimeLogQueryPort,
  RuntimeLogSessionQuery,
  RuntimeLogSessionReadPage,
  RuntimeSnapshotCodec,
} from '@kite/runtime-host/storage';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  RuntimeLogRequestValidationError,
} from '@kite/runtime-host/storage';
import { openSqliteRuntimeLogConnection } from './connection';
import {
  assertCurrentSqliteRuntimeStoreConnection,
  assertNoFollowDatabasePath,
  assertSqliteRuntimeStorageCanOpen,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
} from './preflight';

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
    event = codec.decodeEvent(row.event_json);
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
    assertSqliteRuntimeStorageCanOpen(input.databasePath);
  } catch (error) {
    throw queryError(error);
  }
  let closed = false;
  let db: Database;
  try {
    const opened = openSqliteRuntimeLogConnection(input.databasePath);
    try {
      assertCurrentSqliteRuntimeStoreConnection(opened);
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
  } catch (error) {
    throw queryError(error);
  }
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
      db.close();
    },
  });
}
