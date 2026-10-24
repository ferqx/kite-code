import type { Store } from '../port';
import { AgentError } from '../types';
import { readPublicMessages } from './agent-result-display';
import type { SqliteOperations } from './operations';

/** Called inside one read transaction. SSE is only a wakeup; this durable cursor owns coverage. */
export function readMessageChanges(
  db: SqliteOperations,
  input: Parameters<Store['listMessageChanges']>[0],
): Awaited<ReturnType<Store['listMessageChanges']>> {
  db.identity(input.expectedStoreId);
  const meta = db.metadata();
  for (const value of [
    input.afterCursor,
    input.upperCursor,
    input.upperSeq ?? '0',
    input.afterSeq ?? '0',
  ])
    if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
      throw new AgentError('invalid_cursor');
  if (BigInt(input.afterCursor) < BigInt(meta.replayFloor)) throw new AgentError('cursor_expired');
  if (
    BigInt(input.afterCursor) > BigInt(input.upperCursor) ||
    BigInt(input.upperCursor) > BigInt(meta.lastChangeCursor)
  )
    throw new AgentError('cursor_ahead');
  const session = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId);
  if (!session) throw new AgentError('session_not_found');
  const upperSeq = input.upperSeq ?? String(session.next_seq);
  if (BigInt(upperSeq) > BigInt(String(session.next_seq))) throw new AgentError('cursor_ahead');
  const events = db.rows(
    'SELECT * FROM change_event WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT 200',
    input.afterCursor,
    input.upperCursor,
  );
  // Collection may remove rows and their projection proofs. Establish a new baseline.
  if (events.some((event) => String(event.type).endsWith('.history_collected')))
    throw new AgentError('cursor_expired');
  const nextCursor = events.length === 200 ? String(events.at(-1)!.cursor) : input.upperCursor;
  const direct = events
    .filter(
      (event) => event.scope_session_id === input.sessionId && event.type === 'message.updated',
    )
    .map((event) => String(event.object_id));
  // These display facts depend on Command/Execution/Context/Session rows. Re-project
  // their bounded pages on metadata changes, including foreign child/name changes.
  // Ordinary streaming message.updated events take only the direct-ID path.
  const derived = events.some((event) => event.type !== 'message.updated');
  const source = "CASE WHEN json_valid(m.source_json) THEN m.source_json ELSE '{}' END";
  const decision =
    "CASE WHEN json_valid(e.decision_source_json) THEN e.decision_source_json ELSE '{}' END";
  const pageLimit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const candidates = db.rows(
    `SELECT id,seq FROM (
      SELECT m.id,m.seq FROM message m WHERE m.session_id=? AND (
        m.id IN (${direct.map(() => '?').join(',') || 'NULL'})
        ${
          derived
            ? `OR (m.role='user' AND json_array_length(${source},'$.sourceIds')>0)
        OR EXISTS (SELECT 1 FROM json_each(${source},'$.sourceIds') src
          JOIN execution e ON e.id=src.value
          WHERE json_type(${decision},'$.compressionId') IS NOT NULL
            OR json_type(${decision},'$.humanInputInterpretation') IS NOT NULL)`
            : ''
        }
      )
      ${derived ? "UNION ALL SELECT id,seq FROM context_snapshot WHERE session_id=? AND kind='result_ref'" : ''}
    ) WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?`,
    input.sessionId,
    ...direct,
    ...(derived ? [input.sessionId] : []),
    input.afterSeq ?? '0',
    upperSeq,
    pageLimit,
  );
  const ids = candidates.map((row) => String(row.id));
  const messages = ids.length
    ? readPublicMessages(db, input.sessionId, '0', upperSeq, pageLimit, ids)
    : [];
  const visible = new Set(messages.map((message) => message.id));
  return {
    storeId: meta.storeId,
    sessionId: input.sessionId,
    afterCursor: input.afterCursor,
    upperCursor: input.upperCursor,
    highWaterSeq: upperSeq,
    nextCursor,
    nextAfterSeq: candidates.length === pageLimit ? String(candidates.at(-1)!.seq) : null,
    messages,
    removedIds: ids.filter((id) => !visible.has(id)),
  };
}
