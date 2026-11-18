import type { Store } from '../port';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';

/** A routing hint only. Current configuration, credentials and authorization still decide admission. */
export function readLatestBusinessModelPreference(
  db: SqliteOperations,
  input: Parameters<Store['readLatestBusinessModelPreference']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    if (!db.row('SELECT id FROM session WHERE id=?', input.sessionId))
      throw new AgentError('session_not_found');
    const row = db.row(
      `SELECT e.adapter_id AS model_id,e.id AS execution_id,r.id AS run_id
      FROM run r JOIN session s ON s.id=r.session_id AND s.context_selection_id=r.context_selection_id JOIN command c ON c.id=r.origin_command_id JOIN execution e ON e.run_id=r.id
      WHERE r.session_id=? AND c.session_id=r.session_id AND c.subject_id=?
        AND r.status='completed' AND c.kind IN ('run.start','input.follow_up')
        AND e.session_id=r.session_id AND e.origin_command_id=c.id
        AND e.origin_store_id=r.origin_store_id AND c.origin_store_id=r.origin_store_id
        AND e.kind='model' AND e.state='succeeded'
        AND json_valid(e.decision_source_json) AND json_valid(e.result_json)
        AND json_extract(e.decision_source_json,'$.kind')='model_request'
        AND json_type(e.decision_source_json,'$.compressionId') IS NULL
        AND json_type(e.decision_source_json,'$.humanInputInterpretation') IS NULL
        AND COALESCE(json_extract(e.decision_source_json,'$.imageWindow.kind'),'business')='business'
        AND json_extract(e.result_json,'$.finishReason') IN ('stop','tool_calls')
        AND length(e.adapter_id)>0 AND length(e.adapter_id)<=512
      ORDER BY r.rowid DESC,e.rowid DESC LIMIT 1`,
      input.sessionId,
      input.subjectId,
    );
    const value = row
      ? {
          modelId: String(row.model_id),
          runId: String(row.run_id),
          executionId: String(row.execution_id),
        }
      : null;
    db.db.run('COMMIT');
    return value;
  } catch (error) {
    return db.rollback(error);
  }
}
