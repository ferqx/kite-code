import type { Store } from '../port';
import { AgentError, type SessionDirectoryActivity } from '../types';
import type { SqliteOperations } from './operations';

function sequence(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_page');
  return value;
}
function eventTime(value: unknown): number | null {
  if (typeof value !== 'bigint' && typeof value !== 'number') return null;
  const time = Number(value);
  return Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000 ? time : null;
}
/** Short read-only snapshot; rowid is the original persistent allocation order, never a JS number. */
export function readDirectory(
  db: SqliteOperations,
  kind: 'session' | 'workspace',
  input:
    | Parameters<Store['listSessionDirectory']>[0]
    | Parameters<Store['listWorkspaceDirectory']>[0],
) {
  const allowed =
    kind === 'session'
      ? [
          'expectedStoreId',
          'subjectId',
          'workspaceId',
          'afterSeq',
          'upperSeq',
          'snapshotCursor',
          'limit',
        ]
      : ['expectedStoreId', 'afterSeq', 'upperSeq', 'limit'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key)))
    throw new AgentError('invalid_page');
  db.identity(input.expectedStoreId);
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentError('invalid_page');
  db.db.run('BEGIN');
  try {
    const snapshotCursor = db.metadata().lastChangeCursor;
    const sessionInput = input as Parameters<Store['listSessionDirectory']>[0];
    if (
      kind === 'session' &&
      sessionInput.snapshotCursor !== undefined &&
      sequence(sessionInput.snapshotCursor, snapshotCursor) !== snapshotCursor
    )
      throw new AgentError('directory_changed');
    const highWaterSeq = String(
      db.row(`SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) AS seq FROM ${kind}`)!.seq,
    );
    const upperSeq = sequence(input.upperSeq, highWaterSeq),
      afterSeq = sequence(input.afterSeq, '0');
    if (BigInt(upperSeq) > BigInt(highWaterSeq) || BigInt(afterSeq) > BigInt(upperSeq))
      throw new AgentError('invalid_page');
    if (
      kind === 'session' &&
      (typeof sessionInput.subjectId !== 'string' || !sessionInput.subjectId)
    )
      throw new AgentError('directory_scope_denied');
    const rows =
      kind === 'workspace'
        ? db.rows(
            "SELECT *,CAST(rowid AS TEXT) AS directory_seq FROM workspace WHERE rowid>? AND rowid<=? AND json_type(metadata_json,'$.removal') IS NULL ORDER BY rowid LIMIT ?",
            afterSeq,
            upperSeq,
            limit + 1,
          )
        : db.rows(
            `WITH roots AS (
              SELECT s.*,CAST(s.rowid AS TEXT) AS directory_seq FROM session s
              WHERE s.rowid>? AND s.rowid<=? AND s.parent_id IS NULL AND s.delete_requested=0
              AND (? IS NULL OR s.workspace_id=?)
              AND EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.kind='session.create' AND c.subject_id=?)
              ORDER BY s.rowid LIMIT ?
            ), latest_change AS (
              SELECT e.scope_session_id,MAX(e.cursor) AS cursor FROM change_event e
              JOIN roots s ON s.id=e.scope_session_id GROUP BY e.scope_session_id
            ) SELECT s.*,r.id AS activity_run_id,r.status AS activity_run_status,r.is_active AS activity_run_active,
              r.waiting_results_json<>'[]' AS activity_run_waiting,
              EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.status='accepted' AND c.cancelled=0 AND c.root_work_seq>s.stop_boundary
                AND c.kind IN ('run.start','input.follow_up')) AS activity_queued,
              (SELECT COUNT(*) FROM interaction i WHERE i.presentation_session_id=s.id
                AND i.subject_id=? AND i.origin_store_id=? AND i.state='pending') AS activity_pending,
              CASE WHEN json_valid(e.payload_json) THEN
                CASE WHEN json_extract(e.payload_json,'$.format')='kite.session-log'
                  AND json_extract(e.payload_json,'$.version')=1
                  AND json_type(e.payload_json,'$.version')='integer'
                  AND json_type(e.payload_json,'$.occurredAt')='integer'
                  THEN json_extract(e.payload_json,'$.occurredAt') END
                END AS activity_updated_at
            FROM roots s
            LEFT JOIN run r ON r.rowid=(SELECT rowid FROM run WHERE session_id=s.id ORDER BY is_active DESC,rowid DESC LIMIT 1)
            LEFT JOIN latest_change c ON c.scope_session_id=s.id
            LEFT JOIN change_event e ON e.cursor=c.cursor
            ORDER BY CAST(s.directory_seq AS INTEGER)`,
            afterSeq,
            upperSeq,
            sessionInput.workspaceId ?? null,
            sessionInput.workspaceId ?? null,
            sessionInput.subjectId,
            limit + 1,
            sessionInput.subjectId,
            input.expectedStoreId,
          );
    const items = rows.slice(0, limit).map((row) =>
      kind === 'workspace'
        ? {
            seq: String(row.directory_seq),
            workspace: {
              id: String(row.id),
              name: String(row.name),
              rootUri: String(row.root_uri),
            },
          }
        : {
            seq: String(row.directory_seq),
            session: db.session(row),
            activity: {
              updatedAt: eventTime(row.activity_updated_at),
              run:
                row.activity_run_id === null
                  ? null
                  : {
                      id: String(row.activity_run_id),
                      status: row.activity_run_status as NonNullable<
                        SessionDirectoryActivity['run']
                      >['status'],
                      isActive: !!row.activity_run_active,
                      waitingForResults: !!row.activity_run_waiting,
                    },
              queued: !!row.activity_queued,
              pendingInteractions: Number(row.activity_pending),
            },
          },
    );
    const result = {
      storeId: input.expectedStoreId,
      items,
      highWaterSeq,
      upperSeq,
      nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
      snapshotCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
