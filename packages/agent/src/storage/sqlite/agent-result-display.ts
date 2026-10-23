import type { MessageRecord } from '../types';
import type { SqliteOperations } from './operations';

/** Only an accepted result that created a continuation Run becomes a readable bubble.
 * Raw history keeps that admission fact; later Run/selection changes do not reclassify it.
 */
export function readPublicMessages(
  db: SqliteOperations,
  sessionId: string,
  afterSeq: string,
  upperSeq: string,
  limit: number,
): MessageRecord[] {
  // Proof rows can be damaged independently of ordinary transcript messages.
  // Guard each JSON operation itself: SQL predicate evaluation order is not a
  // guarantee that json_valid runs before json_extract/json_type.
  const sourceRequest = "CASE WHEN json_valid(s.request_json) THEN s.request_json ELSE '{}' END";
  const executionResult = "CASE WHEN json_valid(e.result_json) THEN e.result_json ELSE '{}' END";
  const consumeRequest =
    "CASE WHEN json_valid(consume.request_json) THEN consume.request_json ELSE '{}' END";
  const consumeReceipt =
    "CASE WHEN json_valid(consume.receipt_json) THEN consume.receipt_json ELSE '{}' END";
  const reportRequest =
    "CASE WHEN json_valid(report.request_json) THEN report.request_json ELSE '{}' END";
  const reportReceipt =
    "CASE WHEN json_valid(report.receipt_json) THEN report.receipt_json ELSE '{}' END";
  const rows = db.rows(
    `WITH accepted AS (
      SELECT DISTINCT s.id,s.seq
      FROM context_snapshot s
      JOIN execution e ON e.id=s.execution_id AND e.kind='job'
        AND e.session_id=s.session_id AND e.origin_store_id=s.origin_store_id
        AND e.result_revision=s.result_revision AND e.delivery='consumed'
        AND e.state IN('succeeded','failed','cancelled','outcome_unknown')
      JOIN session child ON child.id=e.child_session_id AND child.parent_id=e.session_id
        AND child.root_id=e.root_session_id
      JOIN command origin ON origin.id=e.origin_command_id
        AND origin.origin_store_id=s.origin_store_id AND origin.session_id=e.session_id
        AND origin.subject_id=s.subject_id AND origin.kind='operation.agent'
        AND origin.root_work_command_id=e.root_work_command_id AND origin.root_work_seq=e.root_work_seq
      JOIN command consume ON consume.session_id=s.session_id
        AND consume.kind='job_result.consume' AND consume.status='applied'
        AND consume.origin_store_id=s.origin_store_id AND consume.subject_id=s.subject_id
        AND json_extract(${consumeReceipt},'$.sourceId')=s.id
        AND json_extract(${consumeReceipt},'$.executionId')=e.id
        AND json_extract(${consumeReceipt},'$.resultRevision')=CAST(s.result_revision AS TEXT)
        AND json_extract(${consumeRequest},'$.executionId')=e.id
        AND json_extract(${consumeRequest},'$.resultRevision')=CAST(s.result_revision AS TEXT)
        AND json_extract(${consumeRequest},'$.contextSelectionId')=s.selection_id
        AND json_extract(${consumeRequest},'$.targetRunId') IS json_extract(${sourceRequest},'$.targetRunId')
      JOIN command report ON report.session_id=s.session_id
        AND report.kind IN('job.report','job.report.continue') AND report.status='applied'
        AND report.origin_store_id=s.origin_store_id AND report.subject_id=s.subject_id
        AND consume.id='consume-'||report.id
        AND json_extract(${reportReceipt},'$.mode')='idle_new_turn'
        AND json_extract(${reportReceipt},'$.outcome')='report_started'
        AND json_extract(${reportReceipt},'$.sourceId')=s.id
        AND json_extract(${reportReceipt},'$.executionId')=e.id
        AND json_extract(${reportReceipt},'$.resultRevision')=CAST(s.result_revision AS TEXT)
        AND json_extract(${reportReceipt},'$.contextSelectionId')=s.selection_id
        AND json_extract(${reportRequest},'$.executionId')=e.id
        AND json_extract(${reportRequest},'$.resultRevision')=CAST(s.result_revision AS TEXT)
        AND json_extract(${reportRequest},'$.contextSelectionId')=s.selection_id
      JOIN run target ON target.id=json_extract(${sourceRequest},'$.targetRunId')
        AND target.session_id=s.session_id AND target.origin_store_id=s.origin_store_id
        AND target.origin_command_id=report.id AND target.context_selection_id=s.selection_id
        AND target.id=json_extract(${reportReceipt},'$.runId')
      WHERE s.session_id=? AND s.kind='result_ref' AND s.inclusion='automatic'
        AND json_valid(s.request_json) AND json_valid(e.result_json)
        AND json_valid(consume.request_json) AND json_valid(consume.receipt_json)
        AND json_valid(report.request_json) AND json_valid(report.receipt_json)
        AND COALESCE(json_extract(${sourceRequest},'$.pendingInput'),0)=0
        AND COALESCE(json_extract(${sourceRequest},'$.statusOnly'),0)=0
        AND COALESCE(json_extract(${sourceRequest},'$.diagnostic'),0)=0
        AND json_type(${executionResult},'$.content')='text'
        AND json_extract(${executionResult},'$.outcome')=e.state
    ) SELECT id,seq,'message' AS display_kind FROM message
      WHERE session_id=? AND seq>? AND seq<=?
    UNION ALL SELECT id,seq,'agent_result' AS display_kind FROM accepted WHERE seq>? AND seq<=?
    ORDER BY seq LIMIT ?`,
    sessionId,
    sessionId,
    afterSeq,
    upperSeq,
    afterSeq,
    upperSeq,
    limit,
  );
  return rows.map((row) => {
    if (row.display_kind === 'message')
      return db.message(db.row('SELECT * FROM message WHERE id=?', row.id!)!);
    // Read the same persisted source/carrier identities, never names claimed by result JSON.
    const source = db.row('SELECT * FROM context_snapshot WHERE id=?', row.id!)!;
    const execution = db.row('SELECT * FROM execution WHERE id=?', source.execution_id!)!;
    const child = db.row('SELECT * FROM session WHERE id=?', execution.child_session_id!)!;
    const request = JSON.parse(String(source.request_json)) as { targetRunId?: string | null };
    const result = JSON.parse(String(execution.result_json)) as {
      outcome: NonNullable<MessageRecord['agentResult']>['outcome'];
      content: string;
      modelContent?: unknown;
      details?: { runId?: string };
    };
    let childRunId: string | null = null;
    if (typeof result.details?.runId === 'string') {
      const childRun = db.row(
        'SELECT * FROM run WHERE id=? AND session_id=? AND origin_store_id=?',
        result.details.runId,
        child.id!,
        execution.origin_store_id!,
      );
      const childOrigin = childRun
        ? db.row('SELECT * FROM command WHERE id=?', childRun.origin_command_id!)
        : null;
      // This optional detail link cannot invalidate an otherwise proven result.
      // Damaged child-start/report proof leaves the Run identity unconfirmed.
      try {
        const carrier = childOrigin && db.childCarrier(childOrigin, String(childRun!.id));
        if (carrier?.id === execution.id) childRunId = String(childRun!.id);
      } catch {}
    }
    return {
      id: String(source.id),
      seq: String(source.seq),
      sessionId,
      runId: request.targetRunId ?? null,
      role: 'system',
      status: 'complete',
      content: result.content,
      sourceIds: [String(source.id)],
      agentResult: {
        sourceId: String(source.id),
        executionId: String(execution.id),
        resultRevision: String(source.result_revision),
        childSessionId: String(child.id),
        childRunId,
        name: String(child.title),
        outcome: result.outcome,
        contentComplete: result.modelContent === undefined,
      },
    };
  });
}
