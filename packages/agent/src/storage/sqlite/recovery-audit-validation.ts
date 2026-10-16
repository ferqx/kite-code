import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

export type AuditRow = Record<string, string | number | bigint | null>;
export const auditJsonRow = (row: AuditRow): Json =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value,
    ]),
  );
const parse = (value: AuditRow[string] | undefined): Record<string, Json> | null => {
  try {
    return value == null ? null : JSON.parse(String(value));
  } catch (error) {
    if (error instanceof SyntaxError) throw new AgentError('run_resume_checkpoint_unavailable');
    throw error;
  }
};

export function assertEffectFreeModel(db: SqliteOperations, execution: AuditRow): void {
  const source = parse(execution.decision_source_json);
  const command = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
  const carrier = command && db.childCarrier(command, String(execution.run_id));
  if (
    execution.kind !== 'model' ||
    execution.parent_execution_id !== (carrier?.id ?? null) ||
    execution.cancel_requested ||
    source?.kind !== 'model_request' ||
    source.requestId !== execution.id ||
    db.row(
      `SELECT id FROM execution WHERE session_id=? AND kind IN('tool','job') AND step_id=?
       UNION ALL SELECT id FROM execution WHERE session_id=? AND kind IN('tool','job') AND parent_execution_id=?
       UNION ALL SELECT id FROM execution WHERE session_id=? AND kind IN('tool','job') AND json_extract(CASE WHEN json_valid(decision_source_json) THEN decision_source_json ELSE '{}' END,'$.modelExecutionId')=? LIMIT 1`,
      execution.session_id!,
      execution.step_id!,
      execution.session_id!,
      execution.id!,
      execution.session_id!,
      execution.id!,
    )
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
}

/** The same semantic checks run when a row changes and in the legacy full audit. */
export function assertHistoricalExecution(
  db: SqliteOperations,
  e: AuditRow,
  storeId: string,
  rootId: string,
): void {
  if (e.origin_store_id !== storeId) throw new AgentError('operation_unverifiable');
  // Preserve the full audit's syntax validation without trusting a preview or
  // turning a malformed historical source into an untracked eligible record.
  parse(e.decision_source_json);
  if (rootId !== e.root_session_id) throw new AgentError('operation_unverifiable');
  if (e.state === 'outcome_unknown') throw new AgentError('run_resume_checkpoint_unavailable');
  if (e.kind === 'tool' && ['succeeded', 'failed', 'cancelled'].includes(String(e.state))) {
    const result = parse(e.result_json);
    if (!result || result.outcome !== e.state || typeof result.content !== 'string')
      throw new AgentError('run_resume_checkpoint_unavailable');
  }
  if (e.kind !== 'model' || ['planned', 'dispatching', 'running'].includes(String(e.state))) return;
  const result = parse(e.result_json);
  if (e.state === 'failed') {
    if (result?.incomplete !== true || typeof result.content !== 'string')
      throw new AgentError('run_resume_checkpoint_unavailable');
    assertEffectFreeModel(db, e);
  } else if (
    e.state !== 'succeeded' ||
    !result ||
    typeof result.content !== 'string' ||
    !['stop', 'tool_calls', 'length'].includes(String(result.finishReason)) ||
    !Array.isArray(result.toolCalls) ||
    (result.finishReason === 'length' && result.toolCalls.length !== 0) ||
    (result.modelOutput && !(result.modelOutput as Record<string, Json>).complete)
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
}

export function assertHistoricalInteraction(
  db: SqliteOperations,
  i: AuditRow,
  run: AuditRow,
  storeId: string,
): void {
  if (!['pending', 'answered'].includes(String(i.state))) return;
  const original = db.row('SELECT subject_id FROM command WHERE id=?', run.origin_command_id!);
  const e = db.row(
    'SELECT * FROM execution WHERE id=? AND run_id=? AND session_id=?',
    i.execution_id!,
    run.id!,
    run.session_id!,
  );
  if (
    e?.state !== 'planned' ||
    i.origin_store_id !== storeId ||
    i.subject_id !== original?.subject_id ||
    i.attempt !== e.attempt
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
}

export function recoveryRecordDigest(row: AuditRow): string {
  return canonicalJson(auditJsonRow(row));
}
