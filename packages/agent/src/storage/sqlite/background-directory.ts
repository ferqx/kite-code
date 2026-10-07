import type { Store } from '../port';
import {
  AgentError,
  type BackgroundExecution,
  type BackgroundExecutionPage,
  type BackgroundRun,
} from '../types';
import type { SqliteOperations } from './operations';

function decimal(value: string | undefined, fallback: string) {
  const text = value ?? fallback;
  if (
    typeof text !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(text) ||
    BigInt(text) > 9223372036854775807n
  )
    throw new AgentError('invalid_page');
  return text;
}
/** Original Job rows only; authorization, scope and allocation fences precede paging. */
export function readBackgroundExecutions(
  db: SqliteOperations,
  input: Parameters<Store['listBackgroundExecutions']>[0],
): BackgroundExecutionPage {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          'expectedStoreId',
          'subjectId',
          'workspaceId',
          'rootSessionId',
          'executionId',
          'afterSeq',
          'upperSeq',
          'snapshotCursor',
          'limit',
        ].includes(key),
    )
  )
    throw new AgentError('invalid_page');
  db.identity(input.expectedStoreId);
  if (typeof input.subjectId !== 'string' || !input.subjectId)
    throw new AgentError('directory_scope_denied');
  for (const field of ['workspaceId', 'rootSessionId', 'executionId'] as const)
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field]))
      throw new AgentError('invalid_page');
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentError('invalid_page');
  db.db.run('BEGIN');
  try {
    const snapshotCursor = db.metadata().lastChangeCursor;
    if (
      input.snapshotCursor !== undefined &&
      decimal(input.snapshotCursor, snapshotCursor) !== snapshotCursor
    )
      throw new AgentError('directory_changed');
    const highWaterSeq = String(
      db.row('SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) AS seq FROM execution')!.seq,
    );
    const upperSeq = decimal(input.upperSeq, highWaterSeq),
      afterSeq = decimal(input.afterSeq, '0');
    if (BigInt(upperSeq) > BigInt(highWaterSeq) || BigInt(afterSeq) > BigInt(upperSeq))
      throw new AgentError('invalid_page');
    const rows = db.rows(
      `WITH RECURSIVE eligible(id,root_id,workspace_id,restored) AS (
        SELECT r.id,r.id,r.workspace_id,creator.origin_store_id<>? FROM session r JOIN command creator ON creator.session_id=r.id AND creator.kind='session.create'
        WHERE r.parent_id IS NULL AND r.root_id=r.id AND r.delete_requested=0
        AND (? IS NULL OR r.workspace_id=?) AND (? IS NULL OR r.id=?)
        AND creator.subject_id=?
        UNION
        SELECT child.id,parent.root_id,parent.workspace_id,parent.restored FROM session child JOIN eligible parent ON child.parent_id=parent.id
        WHERE child.root_id=parent.root_id AND child.workspace_id=parent.workspace_id AND child.delete_requested=0
        AND EXISTS(SELECT 1 FROM command c JOIN execution carrier ON carrier.id=json_extract(c.request_json,'$.parentExecutionId') JOIN command o ON o.id=carrier.origin_command_id
          WHERE c.session_id=child.id AND c.kind='child.start' AND carrier.child_session_id=child.id AND carrier.session_id=parent.id AND carrier.root_session_id=parent.root_id
          AND o.session_id=carrier.session_id AND o.root_work_command_id=carrier.root_work_command_id AND o.root_work_seq=carrier.root_work_seq
          AND EXISTS(SELECT 1 FROM command rw WHERE rw.id=carrier.root_work_command_id AND rw.session_id=parent.root_id AND rw.subject_id=c.subject_id AND rw.origin_store_id=carrier.origin_store_id AND rw.seq=carrier.root_work_seq)
          AND c.subject_id=? AND o.subject_id=c.subject_id AND c.origin_store_id=carrier.origin_store_id AND o.origin_store_id=carrier.origin_store_id
          AND c.root_work_command_id=carrier.root_work_command_id AND c.root_work_seq=carrier.root_work_seq)
      ) SELECT e.id,e.session_id,e.run_id,e.origin_command_id,e.origin_store_id,e.root_work_command_id,e.root_work_seq,
      e.parent_execution_id,e.child_session_id,e.root_session_id,e.cancel_with_parent,e.step_id,e.call_id,e.attempt,e.adapter_id,e.definition_version,e.state,
      e.owner_generation,e.cancel_requested,e.cancel_requested_at,e.result_revision,e.delivery,e.delivery_reason,e.delivery_target_session_id,e.context_selection_id,json_extract(e.reference_json,'$.runId') AS reference_run_id,CAST(e.rowid AS TEXT) AS directory_seq FROM execution e
      JOIN eligible s ON s.id=e.session_id JOIN command source ON source.id=e.origin_command_id AND source.session_id=e.session_id
      WHERE e.kind='job' AND e.rowid>? AND e.rowid<=? AND (? IS NULL OR e.id=?)
      AND (e.origin_store_id=? OR s.restored=1) AND source.origin_store_id=e.origin_store_id AND source.subject_id=?
      AND e.root_session_id=s.root_id AND source.root_work_command_id=e.root_work_command_id AND source.root_work_seq=e.root_work_seq
      AND EXISTS(SELECT 1 FROM command root_work WHERE root_work.id=e.root_work_command_id AND root_work.session_id=s.root_id AND root_work.subject_id=source.subject_id AND root_work.origin_store_id=e.origin_store_id AND root_work.seq=e.root_work_seq)
      ORDER BY e.rowid LIMIT ?`,
      input.expectedStoreId,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
      input.rootSessionId ?? null,
      input.rootSessionId ?? null,
      input.subjectId,
      input.subjectId,
      afterSeq,
      upperSeq,
      input.executionId ?? null,
      input.executionId ?? null,
      input.expectedStoreId,
      input.subjectId,
      limit + 1,
    );
    const leanRun = (id: string | null): BackgroundRun | null => {
      if (!id) return null;
      const row = db.row(
        'SELECT id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,context_selection_id,waiting_results_json,status,is_active,started_at,deadline_at,finished_at,reason,NULL AS config_json,NULL AS requirements_json FROM run WHERE id=?',
        id,
      );
      if (!row) throw new AgentError('directory_identity_conflict');
      const {
        configuration: _configuration,
        requirements: _requirements,
        ...run
      } = db.runRecord(row);
      return run;
    };
    const items = rows.slice(0, limit).map((row) => {
      const nullable = (name: string) => (row[name] === null ? null : String(row[name]));
      const session = db.session(db.row('SELECT * FROM session WHERE id=?', row.session_id!)!);
      const rootSession = db.session(
        db.row('SELECT * FROM session WHERE id=?', session.rootSessionId)!,
      );
      if (
        String(row.root_session_id) !== rootSession.id ||
        session.workspaceId !== rootSession.workspaceId
      )
        throw new AgentError('directory_identity_conflict');
      const execution: BackgroundExecution = {
        id: String(row.id),
        sessionId: session.id,
        rootSessionId: rootSession.id,
        originStoreId: String(row.origin_store_id),
        originCommandId: String(row.origin_command_id),
        rootWorkCommandId: String(row.root_work_command_id),
        rootWorkSeq: String(row.root_work_seq),
        runId: nullable('run_id'),
        parentExecutionId: nullable('parent_execution_id'),
        childSessionId: nullable('child_session_id'),
        cancelWithParent: !!row.cancel_with_parent,
        stepId: String(row.step_id),
        callId: String(row.call_id),
        attempt: Number(row.attempt),
        kind: 'job',
        definitionId: String(row.adapter_id),
        definitionVersion: String(row.definition_version),
        status: row.state as BackgroundExecution['status'],
        ownerGeneration: String(row.owner_generation),
        cancelRequested: !!row.cancel_requested,
        cancelRequestedAt:
          row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
        resultRevision: String(row.result_revision),
        delivery: row.delivery as BackgroundExecution['delivery'],
        deliveryReason: nullable('delivery_reason'),
        deliveryTargetSessionId: nullable('delivery_target_session_id'),
        contextSelectionId: nullable('context_selection_id'),
      };
      let parentRunId = execution.runId,
        parentId = execution.parentExecutionId;
      const visited = new Set([execution.id]);
      while (parentRunId === null && parentId !== null) {
        if (visited.has(parentId)) throw new AgentError('directory_identity_conflict');
        visited.add(parentId);
        const parent = db.row(
          'SELECT id,run_id,parent_execution_id,session_id,origin_store_id,root_work_command_id,root_work_seq FROM execution WHERE id=?',
          parentId,
        );
        if (
          !parent ||
          String(parent.session_id) !== session.id ||
          String(parent.origin_store_id) !== execution.originStoreId ||
          String(parent.root_work_command_id) !== execution.rootWorkCommandId ||
          String(parent.root_work_seq) !== execution.rootWorkSeq
        )
          throw new AgentError('directory_identity_conflict');
        parentRunId = parent.run_id === null ? null : String(parent.run_id);
        parentId = parent.parent_execution_id === null ? null : String(parent.parent_execution_id);
      }
      const run = leanRun(parentRunId);
      const childSessionRow = execution.childSessionId
        ? db.row('SELECT * FROM session WHERE id=?', execution.childSessionId)
        : null;
      if (execution.childSessionId && !childSessionRow)
        throw new AgentError('directory_identity_conflict');
      const childSession = childSessionRow ? db.session(childSessionRow) : null;
      const command = db.row(
        'SELECT session_id,origin_store_id,root_work_command_id,root_work_seq FROM command WHERE id=?',
        execution.originCommandId,
      );
      if (
        !command ||
        String(command.session_id) !== session.id ||
        String(command.origin_store_id) !== execution.originStoreId ||
        String(command.root_work_command_id) !== execution.rootWorkCommandId ||
        String(command.root_work_seq) !== execution.rootWorkSeq
      )
        throw new AgentError('directory_identity_conflict');
      const childStart = childSession
        ? db.row(
            "SELECT * FROM command WHERE id=? AND session_id=? AND kind='child.start'",
            `child-start-${execution.id}`,
            childSession.id,
          )
        : null;
      if (
        childSession &&
        (!childStart ||
          childStart.subject_id !== input.subjectId ||
          childStart.origin_store_id !== execution.originStoreId ||
          childStart.root_work_command_id !== execution.rootWorkCommandId ||
          String(childStart.root_work_seq) !== execution.rootWorkSeq ||
          JSON.parse(String(childStart.request_json)).parentExecutionId !== execution.id)
      )
        throw new AgentError('directory_identity_conflict');
      const childRow = childSession
        ? db.row(
            'SELECT id FROM run WHERE session_id=? AND origin_command_id=?',
            childSession.id,
            `child-start-${execution.id}`,
          )
        : null;
      const childRun = leanRun(childRow ? String(childRow.id) : null);
      const referenceRunId = row.reference_run_id ?? undefined;
      if (
        (run &&
          (run.sessionId !== session.id ||
            run.originStoreId !== execution.originStoreId ||
            run.rootWorkCommandId !== execution.rootWorkCommandId ||
            run.rootWorkSeq !== execution.rootWorkSeq)) ||
        (childSession &&
          (childSession.parentSessionId !== session.id ||
            childSession.rootSessionId !== rootSession.id ||
            childSession.workspaceId !== session.workspaceId)) ||
        (childRun &&
          (childRun.originStoreId !== execution.originStoreId ||
            childRun.rootWorkCommandId !== execution.rootWorkCommandId ||
            childRun.rootWorkSeq !== execution.rootWorkSeq)) ||
        (referenceRunId !== undefined && referenceRunId !== childRun?.id)
      )
        throw new AgentError('directory_identity_conflict');
      return {
        seq: String(row.directory_seq),
        execution,
        session,
        rootSession,
        run,
        childRun,
        childSession,
      };
    });
    const result = {
      storeId: input.expectedStoreId,
      items,
      highWaterSeq,
      upperSeq,
      nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
      snapshotCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
