import type { Database } from 'bun:sqlite';
import type { RuntimeEventMetadata, StoredRuntimeEvent } from '@kite/runtime-host/storage';
import { type EventRow, eventMetadataAt, type SqliteRuntimeSnapshotCodec } from './preflight';

/** Event persistence over the adapter's one database connection. */
export function createSqliteEventStore<Event>(input: {
  readonly db: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, unknown>;
  readonly stateSchemaVersion: number;
  readonly isClosed: () => boolean;
}) {
  const insertEvent = input.db.query(
    'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())',
  );
  const insertEventWithMetadata = input.db.query(
    'INSERT OR IGNORE INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
  );
  const insertForkEvent = input.db.query(
    'INSERT INTO runtime_events (session_id, event_json, event_id, sequence, schema_version, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectEvents = input.db.query<EventRow, [string, number]>(
    'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC',
  );
  const selectAllEvents = input.db.query<EventRow, [string]>(
    'SELECT sequence AS id, session_id AS thread_id, event_json, event_id, sequence AS revision, causation_id, occurred_at, created_at FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC',
  );
  const selectLastEventPosition = input.db.query<{ id: number | null }, [string]>(
    'SELECT MAX(sequence) AS id FROM runtime_events WHERE session_id = ?',
  );
  const selectEventRevisionAtOrBefore = input.db.query<{ revision: number }, [string, number]>(
    'SELECT sequence AS revision FROM runtime_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1',
  );
  const deleteEvents = input.db.query('DELETE FROM runtime_events WHERE session_id = ?');
  const deleteEventsAfter = input.db.query(
    'DELETE FROM runtime_events WHERE session_id = ? AND sequence > ?',
  );

  const lastEventPosition = (sessionId: string): number =>
    selectLastEventPosition.get(sessionId)?.id ?? 0;

  const insertEvents = (
    sessionId: string,
    events: readonly Event[],
    metadata?: readonly RuntimeEventMetadata[],
    forkCreatedAt?: readonly number[],
  ): void => {
    for (const [index, event] of events.entries()) {
      const entry = eventMetadataAt(metadata, index);
      const implicitSequence = lastEventPosition(sessionId) + 1;
      const eventId = entry?.eventId ?? `${sessionId}:${implicitSequence}`;
      const json = input.codec.encodeEvent(event);
      if (entry) {
        if (forkCreatedAt) {
          insertForkEvent.run(
            sessionId,
            json,
            entry.eventId,
            entry.revision,
            input.stateSchemaVersion,
            entry.causationId ?? null,
            entry.occurredAt ?? null,
            forkCreatedAt[index] ?? 0,
          );
        } else {
          insertEventWithMetadata.run(
            sessionId,
            json,
            entry.eventId,
            entry.revision,
            input.stateSchemaVersion,
            entry.causationId ?? null,
            entry.occurredAt ?? new Date().toISOString(),
          );
        }
      } else if (forkCreatedAt) {
        insertForkEvent.run(
          sessionId,
          json,
          eventId,
          implicitSequence,
          input.stateSchemaVersion,
          null,
          null,
          forkCreatedAt[index] ?? 0,
        );
      } else {
        insertEvent.run(sessionId, eventId, implicitSequence, input.stateSchemaVersion, json);
      }
    }
  };

  const loadEvents = (sessionId: string, since?: number): StoredRuntimeEvent<Event>[] => {
    if (input.isClosed()) return [];
    const rows =
      since == null ? selectAllEvents.all(sessionId) : selectEvents.all(sessionId, since);
    return rows.map((row) => ({
      id: row.id,
      thread_id: row.thread_id,
      event: input.codec.decodeEvent(row.event_json),
      created_at: row.created_at,
      ...(row.event_id ? { event_id: row.event_id } : {}),
      revision: row.revision,
      ...(row.causation_id ? { causation_id: row.causation_id } : {}),
      ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
    }));
  };

  return Object.freeze({
    insertEvents,
    loadEvents,
    lastEventPosition,
    revisionAtOrBefore: (sessionId: string, position: number) =>
      selectEventRevisionAtOrBefore.get(sessionId, position)?.revision ?? 0,
    deleteAll: (sessionId: string) => deleteEvents.run(sessionId),
    deleteAfter: (sessionId: string, position: number) =>
      deleteEventsAfter.run(sessionId, position),
    insertSerializedForkEvent: (record: {
      readonly sessionId: string;
      readonly eventJson: string;
      readonly eventId: string;
      readonly revision: number;
      readonly causationId: string | null;
      readonly occurredAt: string | null;
      readonly createdAt: number;
    }) =>
      insertForkEvent.run(
        record.sessionId,
        record.eventJson,
        record.eventId,
        record.revision,
        input.stateSchemaVersion,
        record.causationId,
        record.occurredAt,
        record.createdAt,
      ),
  });
}
