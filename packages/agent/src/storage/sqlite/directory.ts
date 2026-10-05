import type { Store } from '../port';
import { AgentError } from '../types';
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
      ? ['expectedStoreId', 'subjectId', 'workspaceId', 'afterSeq', 'upperSeq', 'limit']
      : ['expectedStoreId', 'afterSeq', 'upperSeq', 'limit'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key)))
    throw new AgentError('invalid_page');
  db.identity(input.expectedStoreId);
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentError('invalid_page');
  db.db.run('BEGIN');
  try {
    const highWaterSeq = String(
      db.row(`SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) AS seq FROM ${kind}`)!.seq,
    );
    const upperSeq = sequence(input.upperSeq, highWaterSeq),
      afterSeq = sequence(input.afterSeq, '0');
    if (BigInt(upperSeq) > BigInt(highWaterSeq) || BigInt(afterSeq) > BigInt(upperSeq))
      throw new AgentError('invalid_page');
    const sessionInput = input as Parameters<Store['listSessionDirectory']>[0];
    if (
      kind === 'session' &&
      (typeof sessionInput.subjectId !== 'string' || !sessionInput.subjectId)
    )
      throw new AgentError('directory_scope_denied');
    const rows =
      kind === 'workspace'
        ? db.rows(
            'SELECT *,CAST(rowid AS TEXT) AS directory_seq FROM workspace WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?',
            afterSeq,
            upperSeq,
            limit + 1,
          )
        : db.rows(
            `SELECT s.*,CAST(s.rowid AS TEXT) AS directory_seq FROM session s WHERE s.rowid>? AND s.rowid<=? AND s.parent_id IS NULL AND s.delete_requested=0 AND (? IS NULL OR s.workspace_id=?) AND EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.kind='session.create' AND c.subject_id=?) ORDER BY s.rowid LIMIT ?`,
            afterSeq,
            upperSeq,
            sessionInput.workspaceId ?? null,
            sessionInput.workspaceId ?? null,
            sessionInput.subjectId,
            limit + 1,
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
        : { seq: String(row.directory_seq), session: db.session(row) },
    );
    const result = {
      storeId: input.expectedStoreId,
      items,
      highWaterSeq,
      upperSeq,
      nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
      snapshotCursor: db.metadata().lastChangeCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
