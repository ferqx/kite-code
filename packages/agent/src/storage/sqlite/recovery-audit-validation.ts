import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import { validateAgentSource } from './agent-input-operations';
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

/** Only a proven applied steer can retire this exact, never-dispatched Model. */
function assertSupersededModel(db: SqliteOperations, execution: AuditRow): void {
  const result = parse(execution.result_json);
  const details = result?.details as Record<string, Json> | undefined;
  const input =
    typeof details?.inputCommandId === 'string'
      ? db.row('SELECT * FROM command WHERE id=?', details.inputCommandId)
      : undefined;
  const run = db.row('SELECT * FROM run WHERE id=?', execution.run_id!);
  const origin = run && db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
  const request = input && parse(input.request_json);
  const receipt = input && parse(input.receipt_json);
  const message =
    typeof receipt?.messageId === 'string'
      ? db.row('SELECT * FROM message WHERE id=?', receipt.messageId)
      : undefined;
  const body = message && parse(message.source_json);
  if (
    (execution.dispatched !== 0n && execution.dispatched !== 0) ||
    result?.outcome !== 'cancelled' ||
    result.content !== 'superseded_by_user_input' ||
    details?.code !== 'superseded_by_user_input' ||
    details.adapterAttempted !== false ||
    !input ||
    input.kind !== 'input.steer' ||
    input.status !== 'applied' ||
    (input.agent_source_execution_id === null) !== (input.agent_carrier_execution_id === null) ||
    input.session_id !== execution.session_id ||
    input.origin_store_id !== execution.origin_store_id ||
    input.root_work_command_id !== execution.root_work_command_id ||
    String(input.root_work_seq) !== String(execution.root_work_seq) ||
    input.input_target_run_id !== execution.run_id ||
    !origin ||
    input.subject_id !== origin.subject_id ||
    run?.session_id !== execution.session_id ||
    run.origin_command_id !== execution.origin_command_id ||
    input.input_context_selection_id !== run.context_selection_id ||
    request?.kind !== 'input.steer' ||
    request.targetRunId !== execution.run_id ||
    request.contextSelectionId !== input.input_context_selection_id ||
    createHash('sha256').update(canonicalJson(request)).digest('hex') !== input.request_digest ||
    receipt?.outcome !== 'input_applied' ||
    receipt.runId !== execution.run_id ||
    receipt.contextSelectionId !== input.input_context_selection_id ||
    !Array.isArray(receipt.supersededExecutionIds) ||
    !receipt.supersededExecutionIds.includes(String(execution.id)) ||
    !message ||
    message.session_id !== execution.session_id ||
    message.run_id !== execution.run_id ||
    message.role !== 'user' ||
    message.status !== 'complete' ||
    !body ||
    body.originCommandId !== input.id ||
    body.inputKind !== 'input.steer' ||
    body.contextSelectionId !== input.input_context_selection_id ||
    !Array.isArray(body.sourceIds) ||
    body.sourceIds.length !== 1 ||
    body.sourceIds[0] !== input.id ||
    body.content !== request.content ||
    canonicalJson(body.images ?? null) !== canonicalJson(request.images ?? null) ||
    canonicalJson(body.files ?? null) !== canonicalJson(request.files ?? null)
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
  const session = db.row('SELECT * FROM session WHERE id=?', execution.session_id!);
  if (!session) throw new AgentError('run_resume_checkpoint_unavailable');
  if (session.parent_id !== null) {
    const source = db.row('SELECT * FROM execution WHERE id=?', input.agent_source_execution_id!);
    const carrier = db.childCarrier(origin, String(execution.run_id));
    const envelope = typeof request.content === 'string' ? parse(request.content) : null;
    if (
      source?.kind !== 'tool' ||
      (source.dispatched !== 1n && source.dispatched !== 1) ||
      source.session_id !== session.parent_id ||
      !carrier ||
      carrier.id !== input.agent_carrier_execution_id ||
      envelope?.kind !== 'agent_message' ||
      envelope.sourceSessionId !== source.session_id ||
      envelope.sourceExecutionId !== source.id ||
      envelope.carrierExecutionId !== carrier.id ||
      typeof envelope.content !== 'string'
    )
      throw new AgentError('run_resume_checkpoint_unavailable');
  } else if (input.agent_source_execution_id !== null) {
    throw new AgentError('run_resume_checkpoint_unavailable');
  }
  validateAgentSource(db, input);
  assertEffectFreeModel(db, execution);
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
  if (e.state === 'cancelled') {
    assertSupersededModel(db, e);
  } else if (e.state === 'failed') {
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
