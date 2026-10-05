import { bodyReference } from '../../model-body';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

/** Short transaction check of immutable registered identity; full byte reads occur in Core before Provider I/O. */
export function verifyModelBody(
  db: SqliteOperations,
  input: Json,
  execution: Record<string, string | number | bigint | null>,
): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const body = bodyReference(input.body ?? input.sourceBody);
  if (!body) return input;
  const ref = body.reference;
  const command = db.row('SELECT subject_id FROM command WHERE id=?', execution.origin_command_id!);
  const row = db.row(
    'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=?',
    ref.id,
  );
  if (
    !row ||
    !command ||
    ref.storeId !== execution.origin_store_id ||
    ref.sessionId !== execution.session_id ||
    ref.subjectId !== command.subject_id ||
    row.origin_store_id !== ref.storeId ||
    row.session_id !== ref.sessionId ||
    row.subject_id !== ref.subjectId ||
    row.blob_hash !== ref.hash ||
    String(row.size) !== ref.size ||
    row.media_type !== ref.mediaType ||
    row.owner_kind !== ref.scope.kind ||
    row.owner_id !== ref.scope.id ||
    ref.scope.kind !== 'session' ||
    ref.scope.id !== ref.sessionId
  )
    throw new AgentError('model_body_invalid');
  return input;
}
