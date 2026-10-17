import type { CompressionRecord, Json, MessageRecord } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
/** Model success alone is not publication. Derive display facts only from exact SQL ownership. */
export function compressionDisplay(
  db: SqliteOperations,
  row: Row,
  source: Record<string, Json>,
): MessageRecord['compression'] {
  if (
    row.role !== 'assistant' ||
    row.run_id === null ||
    !Array.isArray(source.sourceIds) ||
    source.sourceIds.length !== 1 ||
    typeof source.sourceIds[0] !== 'string'
  )
    return;
  const execution = db.row(
    "SELECT * FROM execution WHERE id=? AND session_id=? AND run_id=? AND kind='model'",
    source.sourceIds[0],
    row.session_id!,
    row.run_id!,
  );
  if (!execution) return;
  const decision = JSON.parse(String(execution.decision_source_json)) as { compressionId?: string };
  if (typeof decision?.compressionId !== 'string') return;
  const snapshot = db.row(
    "SELECT * FROM context_snapshot WHERE id=? AND session_id=? AND kind IN('compression_pending','compression')",
    decision.compressionId,
    row.session_id!,
  );
  if (!snapshot) return;
  const record = JSON.parse(String(snapshot.request_json)) as CompressionRecord;
  if (
    record.id !== decision.compressionId ||
    record.modelExecutionId !== execution.id ||
    record.sessionId !== row.session_id ||
    record.runId !== row.run_id ||
    record.originStoreId !== execution.origin_store_id ||
    !['manual', 'automatic'].includes(record.trigger)
  )
    return;
  return {
    id: record.id,
    trigger: record.trigger,
    status:
      snapshot.kind === 'compression'
        ? 'completed'
        : execution.state === 'failed'
          ? 'failed'
          : execution.state === 'cancelled'
            ? 'cancelled'
            : ['planned', 'dispatching', 'running'].includes(String(execution.state))
              ? 'running'
              : 'unpublished',
  };
}
