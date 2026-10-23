import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;

/** This marker selects a protocol, never supplies result admission authority. */
export function resultMailMarker(c = 'c'): string {
  return `(${c}.kind IN('job.report','job.report.continue') AND COALESCE(json_extract(CASE WHEN json_valid(${c}.request_json) THEN ${c}.request_json ELSE '{}' END,'$.mailboxVersion')=1,0))`;
}

/** Damaged or unsupported result mail cannot downgrade into the historical report protocol. */
export function resultMailEnvelope(c = 'c'): string {
  const request = `CASE WHEN json_valid(${c}.request_json) THEN ${c}.request_json ELSE '{}' END`;
  return `(${c}.kind IN('job.report','job.report.continue') AND (
    json_type(${request},'$.mailboxVersion') IS NOT NULL
    OR ${c}.agent_source_execution_id IS NOT NULL OR ${c}.mail_target_session_id IS NOT NULL
    OR ${c}.mail_selection_id IS NOT NULL OR ${c}.mail_confirmed<>0
    OR ${c}.mail_target_run_id IS NOT NULL OR ${c}.mail_received_run_id IS NOT NULL
    OR ${c}.mail_received_selection_id IS NOT NULL OR ${c}.mail_received_message_id IS NOT NULL))`;
}

/** Mail identity is sealed against the actual child carrier and its subscription. */
export function resultMailPredicate(c = 'c', e = 'e'): string {
  const request = `CASE WHEN json_valid(${c}.request_json) THEN ${c}.request_json ELSE '{}' END`;
  const subscription = `CASE WHEN json_valid(${e}.after_turn_json) THEN ${e}.after_turn_json ELSE '{}' END`;
  return `(${resultMailMarker(c)} AND ${e}.kind='job' AND ${e}.child_session_id IS NOT NULL
    AND json_extract(${subscription},'$.kind')='agent_completion'
    AND ${c}.agent_source_execution_id=${e}.id AND ${c}.mail_confirmed=1
    AND ${c}.mail_received_message_id IS NULL
    AND ${c}.session_id=${e}.session_id AND ${c}.mail_target_session_id=${e}.session_id
    AND ${c}.origin_store_id=${e}.origin_store_id
    AND ${c}.root_work_command_id=${e}.root_work_command_id AND ${c}.root_work_seq=${e}.root_work_seq
    AND ${c}.mail_selection_id=json_extract(${subscription},'$.contextSelectionId')
    AND json_extract(${request},'$.executionId')=${e}.id
    AND json_extract(${request},'$.resultRevision')=CAST(${e}.result_revision AS TEXT)
    AND json_extract(${request},'$.contextSelectionId')=${c}.mail_selection_id
    AND json_extract(${request},'$.parentRunId')=json_extract(${subscription},'$.parentRunId')
    AND EXISTS(SELECT 1 FROM session child WHERE child.id=${e}.child_session_id
      AND child.parent_id=${e}.session_id AND child.root_id=${e}.root_session_id)
    AND EXISTS(SELECT 1 FROM command origin WHERE origin.id=${e}.origin_command_id
      AND origin.kind='operation.agent' AND origin.subject_id=${c}.subject_id
      AND origin.session_id=${e}.session_id AND origin.origin_store_id=${e}.origin_store_id))`;
}

/** Called in the carrier terminal/continuation transaction, before any observer can see it. */
export function sealResultMail(db: SqliteOperations, commandId: string, execution: Row): void {
  db.run(
    'UPDATE command SET agent_source_execution_id=?,mail_target_session_id=?,mail_selection_id=?,mail_confirmed=1 WHERE id=?',
    execution.id!,
    execution.session_id!,
    JSON.parse(String(execution.after_turn_json)).contextSelectionId,
    commandId,
  );
  if (db.row('SELECT status FROM command WHERE id=?', commandId)?.status === 'accepted')
    db.event(String(execution.session_id), commandId, 'agent.message_ready');
}
