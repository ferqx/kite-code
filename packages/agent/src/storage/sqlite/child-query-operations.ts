import type { Store } from '../port';
import { AgentError, type AgentSummary, type AgentSummaryPage } from '../types';
import type { SqliteOperations } from './operations';

const decimal = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_cursor');
  return BigInt(value);
};
const columns = `SELECT c.id AS command_id,c.session_id,c.operation_key,c.extension_id,c.origin_store_id,c.seq,c.subject_id,c.root_work_command_id AS command_root_work,c.root_work_seq AS command_root_seq,
 (SELECT i.id FROM interaction i JOIN execution ie ON ie.id=i.execution_id JOIN command ic ON ic.id=ie.origin_command_id
 WHERE i.origin_store_id=c.origin_store_id AND ie.root_work_command_id=e.root_work_command_id AND ie.root_work_seq=e.root_work_seq
 AND i.state='pending' AND ie.state IN ('planned','dispatching','running') AND ie.cancel_requested=0 AND ic.cancelled=0
 AND (i.execution_id=e.id OR EXISTS(SELECT 1 FROM json_each(i.ancestry_json) a WHERE a.value=e.child_session_id)) ORDER BY i.rowid LIMIT 1) AS waiting_interaction_id,
 e.id AS execution_id,e.origin_store_id AS execution_store,e.state,e.attempt,e.parent_execution_id,e.root_work_command_id,e.root_work_seq,e.child_session_id,e.root_session_id,
 child.context_selection_id,child.parent_id,r.id AS run_id,r.status AS run_status,r.is_active,r.deadline_at,
 r.origin_store_id AS run_store,r.root_work_command_id AS run_root_work,r.root_work_seq AS run_root_seq
 FROM command c JOIN execution e ON e.origin_command_id=c.id JOIN session child ON child.id=e.child_session_id
 LEFT JOIN run r ON r.id=json_extract(e.reference_json,'$.runId') AND r.origin_command_id=('child-start-'||e.id) AND r.session_id=child.id
 WHERE c.kind='operation.agent' AND e.kind='job' AND c.session_id=? AND c.extension_id=? AND c.subject_id=?`;
function project(
  row: Record<string, string | number | bigint | null>,
  storeId: string,
): AgentSummary {
  if (
    row.origin_store_id !== storeId ||
    row.execution_store !== storeId ||
    row.command_root_work !== row.root_work_command_id ||
    String(row.command_root_seq) !== String(row.root_work_seq) ||
    row.parent_id !== row.session_id ||
    (row.run_id !== null &&
      (row.run_store !== storeId ||
        row.run_root_work !== row.root_work_command_id ||
        String(row.run_root_seq) !== String(row.root_work_seq)))
  )
    throw new AgentError('operation_unverifiable');
  return {
    ref: {
      commandId: String(row.command_id),
      sessionId: String(row.session_id),
      extensionId: String(row.extension_id),
      originStoreId: storeId,
      key: String(row.operation_key),
      executionId: String(row.execution_id),
      childSessionId: String(row.child_session_id),
    },
    seq: String(row.seq),
    executionId: String(row.execution_id),
    waitingInteractionId:
      row.waiting_interaction_id === null ? null : String(row.waiting_interaction_id),
    status: String(row.state) as AgentSummary['status'],
    attempt: Number(row.attempt),
    originCommandId: String(row.command_id),
    parentExecutionId: row.parent_execution_id === null ? null : String(row.parent_execution_id),
    rootSessionId: String(row.root_session_id),
    rootWorkCommandId: String(row.root_work_command_id),
    rootWorkSeq: String(row.root_work_seq),
    childSessionId: String(row.child_session_id),
    contextSelectionId: String(row.context_selection_id),
    run:
      row.run_id === null
        ? null
        : {
            id: String(row.run_id),
            status: String(row.run_status) as NonNullable<AgentSummary['run']>['status'],
            isActive: !!row.is_active,
            deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
          },
  };
}
export function getAgentSummary(
  db: SqliteOperations,
  input: Parameters<Store['getAgentSummary']>[0],
): AgentSummary {
  db.identity(input.expectedStoreId);
  const ref = input.ref;
  if (ref.originStoreId !== input.expectedStoreId) throw new AgentError('store_identity_mismatch');
  const row = db.row(
    `${columns} AND c.id=? AND c.operation_key=?`,
    ref.sessionId,
    ref.extensionId,
    input.subjectId,
    ref.commandId,
    ref.key,
  );
  if (
    !row ||
    row.execution_id !== ref.executionId ||
    (ref.childSessionId !== undefined && row.child_session_id !== ref.childSessionId)
  )
    throw new AgentError('operation_not_found');
  return project(row, input.expectedStoreId);
}
export function listAgentSummaries(
  db: SqliteOperations,
  input: Parameters<Store['listAgentSummaries']>[0],
): AgentSummaryPage {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT root_id FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AgentError('invalid_page_limit');
    const after = decimal(input.afterSeq ?? '0');
    const water = BigInt(
      db.row(
        "SELECT COALESCE(MAX(seq),0) AS water FROM command WHERE kind='operation.agent' AND session_id=? AND extension_id=? AND subject_id=?",
        input.sessionId,
        input.extensionId,
        input.subjectId,
      )!.water!,
    );
    const upper = decimal(input.upperSeq ?? String(water));
    if (after > upper || upper > water) throw new AgentError('cursor_ahead');
    const rows = db.rows(
      `${columns} AND c.seq>? AND c.seq<=? ORDER BY c.seq LIMIT ?`,
      input.sessionId,
      input.extensionId,
      input.subjectId,
      after,
      upper,
      limit,
    );
    const items = rows.map((row) => project(row, input.expectedStoreId));
    const snapshotCursor = db.metadata().lastChangeCursor;
    db.db.run('COMMIT');
    return {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      rootSessionId: String(session.root_id),
      extensionId: input.extensionId,
      items,
      upperSeq: String(upper),
      highWaterSeq: String(water),
      nextAfterSeq: items.length === limit ? items.at(-1)!.seq : null,
      snapshotCursor,
    };
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
