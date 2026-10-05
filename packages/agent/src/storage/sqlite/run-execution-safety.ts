import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type RunExecutionSafety } from '../types';
import type { SqliteOperations } from './operations';

/** A bounded original execution-group observation, not permission to finish a Run. */
export function readRunExecutionSafety(
  db: SqliteOperations,
  input: Parameters<Store['readRunExecutionSafety']>[0],
): RunExecutionSafety {
  db.identity(input.expectedStoreId);
  const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
  const command = run && db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
  const session = run && db.row('SELECT * FROM session WHERE id=?', run.session_id!);
  if (
    !run ||
    !command ||
    !session ||
    run.session_id !== input.sessionId ||
    run.origin_store_id !== input.expectedStoreId ||
    command.origin_store_id !== input.expectedStoreId ||
    command.subject_id !== input.subjectId
  )
    throw new AgentError('execution_safety_scope_denied');
  if (input.excludeExecutionId) {
    const excluded = db.row('SELECT * FROM execution WHERE id=?', input.excludeExecutionId);
    if (
      !excluded ||
      excluded.run_id !== run.id ||
      excluded.session_id !== run.session_id ||
      excluded.origin_store_id !== input.expectedStoreId ||
      excluded.kind !== 'tool' ||
      !['planned', 'dispatching', 'running'].includes(String(excluded.state))
    )
      throw new AgentError('execution_safety_boundary_invalid');
  }
  const rows = db.rows(
    `WITH RECURSIVE members(id) AS (
    SELECT id FROM execution WHERE run_id=?
    UNION SELECT e.id FROM execution e JOIN members m ON e.parent_execution_id=m.id
    UNION SELECT e.id FROM execution e JOIN execution carrier ON e.session_id=carrier.child_session_id
      JOIN members m ON carrier.id=m.id
    LIMIT 4097
  ) SELECT e.id,e.session_id,e.run_id,e.kind,e.state,e.parent_execution_id,e.child_session_id,
    e.origin_store_id,e.root_session_id,e.root_work_command_id,e.root_work_seq,e.result_revision,
    c.subject_id,s.root_id,s.workspace_id FROM execution e JOIN members m ON e.id=m.id
    JOIN command c ON c.id=e.origin_command_id JOIN session s ON s.id=e.session_id ORDER BY e.id`,
    input.runId,
  );
  if (rows.length > 4096) throw new AgentError('execution_safety_unavailable');
  for (const row of rows) {
    if (
      row.origin_store_id !== input.expectedStoreId ||
      row.subject_id !== input.subjectId ||
      row.root_id !== session.root_id ||
      row.root_session_id !== session.root_id ||
      row.workspace_id !== session.workspace_id ||
      row.root_work_command_id !== run.root_work_command_id ||
      String(row.root_work_seq) !== String(run.root_work_seq)
    )
      throw new AgentError('execution_safety_scope_denied');
  }
  const unconfirmedExecutionIds = rows
    .filter(
      (row) =>
        ['tool', 'job'].includes(String(row.kind)) &&
        row.id !== input.excludeExecutionId &&
        ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(String(row.state)),
    )
    .map((row) => String(row.id));
  const facts = {
    runId: input.runId,
    sessionId: input.sessionId,
    storeId: input.expectedStoreId,
    excludedExecutionId: input.excludeExecutionId ?? null,
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'bigint' ? String(value) : value,
        ]),
      ),
    ),
  };
  return {
    originStoreId: input.expectedStoreId,
    sessionId: input.sessionId,
    runId: input.runId,
    revision: createHash('sha256')
      .update(canonicalJson(facts as unknown as Json))
      .digest('hex'),
    excludedExecutionId: input.excludeExecutionId ?? null,
    unconfirmedExecutionIds,
    unconfirmed: unconfirmedExecutionIds.length !== 0,
  };
}

export function readRunExecutionSafetySnapshot(
  db: SqliteOperations,
  input: Parameters<Store['readRunExecutionSafety']>[0],
) {
  db.db.run('BEGIN');
  try {
    const value = readRunExecutionSafety(db, input);
    db.db.run('COMMIT');
    return value;
  } catch (error) {
    try {
      db.db.run('ROLLBACK');
    } catch {}
    throw error;
  }
}
