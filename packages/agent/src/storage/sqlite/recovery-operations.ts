import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type RecoveryReport } from '../types';
import type { SqliteOperations } from './operations';
import { recoveryToolHistory } from './recovery-history';

type Input = Parameters<Store['recoverSession']>[0];
function request(input: Input): Json {
  return {
    kind: 'session.recover',
    expectedOwnerGeneration: input.expectedOwnerGeneration,
    decision: input.decision,
  };
}
function digest(input: Input): string {
  return createHash('sha256')
    .update(canonicalJson(request(input)))
    .digest('hex');
}
function prior(db: SqliteOperations, input: Input): RecoveryReport | null {
  db.identity(input.expectedStoreId);
  const command = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (!command) return null;
  if (
    command.session_id !== input.sessionId ||
    command.subject_id !== input.subjectId ||
    command.request_digest !== digest(input) ||
    command.kind !== 'session.recover' ||
    command.origin_store_id !== input.expectedStoreId ||
    command.status !== 'applied'
  )
    throw new AgentError('command_conflict');
  return JSON.parse(String(command.receipt_json)) as RecoveryReport;
}
/** One consistent readonly identity/receipt snapshot, before attempting any OS lock. */
export function getRecoveryReceipt(db: SqliteOperations, input: Input): RecoveryReport | null {
  db.db.run('BEGIN');
  try {
    const result = prior(db, input);
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function recoverSession(db: SqliteOperations, input: Input): RecoveryReport {
  return db.tx(() => {
    const existing = prior(db, input);
    if (existing) return existing;
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session || session.delete_requested) throw new AgentError('session_not_found');
    if (session.parent_id !== null) throw new AgentError('group_root_required');
    if (
      db.row(
        "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
        input.sessionId,
      )?.subject_id !== input.subjectId
    )
      throw new AgentError('permission_denied');
    if (String(session.owner_generation) !== input.expectedOwnerGeneration)
      throw new AgentError('owner_changed');
    if (input.decision !== 'interrupt') throw new AgentError('invalid_recovery_decision');
    if (BigInt(session.owner_generation!) >= 9223372036854775807n)
      throw new AgentError('sequence_exhausted');
    const executions = db.rows(
      "SELECT * FROM execution WHERE root_session_id=? AND state IN ('planned','dispatching','running') ORDER BY id LIMIT 4097",
      input.sessionId,
    );
    const runs = db.rows(
      'SELECT id,session_id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1 ORDER BY id LIMIT 4097',
      input.sessionId,
    );
    const partials = db.rows(
      "SELECT id FROM message WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND status='incomplete' ORDER BY id LIMIT 4097",
      input.sessionId,
    );
    if ([executions, runs, partials].some((rows) => rows.length > 4096))
      throw new AgentError('recovery_too_large');
    for (const execution of executions) {
      if (BigInt(execution.result_revision!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
    }
    const histories = executions
      .map((execution) => recoveryToolHistory(db, execution))
      .filter((history) => history !== null);
    if (input.toolHistoryProofs !== undefined) {
      const proofs = input.toolHistoryProofs;
      if (
        !Array.isArray(proofs) ||
        proofs.length !== histories.length ||
        proofs.length > 4096 ||
        proofs.some(
          (proof) =>
            !proof ||
            Object.keys(proof).sort().join(',') !== 'bindingDigest,executionId' ||
            typeof proof.executionId !== 'string' ||
            typeof proof.bindingDigest !== 'string' ||
            !histories.some(
              (history) =>
                history.executionId === proof.executionId &&
                history.bindingDigest === proof.bindingDigest,
            ),
        )
      )
        throw new AgentError('recovery_tool_history_changed');
      if (new Set(proofs.map((proof) => proof.executionId)).size !== proofs.length)
        throw new AgentError('recovery_tool_history_changed');
    } else if (histories.some((history) => history.modelOutput !== null))
      throw new AgentError('recovery_tool_history_unverifiable');
    db.run(
      'UPDATE session SET owner_generation=owner_generation+1,owner_instance=NULL WHERE id=?',
      input.sessionId,
    );
    const report: RecoveryReport = {
      sessionId: input.sessionId,
      storeId: input.expectedStoreId,
      previousGeneration: String(session.owner_generation),
      generation: String(BigInt(session.owner_generation!) + 1n),
      interruptedRunIds: runs.map((row) => String(row.id)),
      settledExecutionIds: [],
      unknownExecutionIds: db
        .rows(
          "SELECT id FROM execution WHERE root_session_id=? AND state='outcome_unknown' ORDER BY id LIMIT 4097",
          input.sessionId,
        )
        .map((row) => String(row.id)),
      cancelledExecutionIds: [],
      partialMessageIds: partials.map((row) => String(row.id)),
      snapshotCursor: '',
    };
    if (report.unknownExecutionIds.length > 4096) throw new AgentError('recovery_too_large');
    for (const execution of executions) {
      const unstarted =
        execution.state === 'planned' &&
        execution.dispatched === 0n &&
        execution.origin_store_id === input.expectedStoreId;
      const state =
        execution.kind === 'model' ? 'failed' : unstarted ? 'cancelled' : 'outcome_unknown';
      const result: Json = {
        code:
          execution.kind === 'model'
            ? 'model_interrupted'
            : unstarted
              ? 'recovery_cancelled_unstarted'
              : 'recovery_outcome_unknown',
        incomplete: execution.kind === 'model',
        recoveryCommandId: input.commandId,
        evidenceSource: 'local_process_recovery',
      };
      db.run(
        'UPDATE execution SET state=?,result_json=?,result_revision=result_revision+1 WHERE id=?',
        state,
        canonicalJson(result),
        execution.id,
      );
      const history = histories.find((history) => history.executionId === execution.id);
      if (history)
        db.appendMessage(
          String(execution.session_id),
          String(execution.run_id),
          {
            content: canonicalJson(result),
            toolCallId: history.callId,
            sourceIds: [String(execution.id)],
          },
          'tool',
        );
      else if (
        execution.kind === 'tool' &&
        execution.run_id !== null &&
        JSON.parse(String(execution.decision_source_json)).kind === 'completion_decision'
      )
        db.appendMessage(
          String(execution.session_id),
          String(execution.run_id),
          {
            content: `<execution_result trust="untrusted" executionId="${String(execution.id)}">${canonicalJson(result)}</execution_result>`,
            sourceIds: [String(execution.id)],
          },
          'user',
        );
      (state === 'failed'
        ? report.settledExecutionIds
        : state === 'cancelled'
          ? report.cancelledExecutionIds
          : report.unknownExecutionIds
      ).push(String(execution.id));
      db.run(
        "UPDATE interaction SET state='cancelled' WHERE execution_id=? AND state IN ('pending','answered') AND accepted_decision_revision IS NULL",
        execution.id,
      );
      db.event(String(execution.session_id), String(execution.id), 'execution.recovered', result);
    }
    for (const run of runs) {
      db.run(
        "UPDATE run SET status='interrupted',is_active=0,finished_at=?,reason=? WHERE id=?",
        Date.now(),
        'explicit_recovery_interrupt',
        run.id,
      );
      db.event(String(run.session_id), String(run.id), 'run.interrupted');
    }
    const pendingCommands = db.rows(
      "SELECT * FROM command WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND kind NOT IN('job.reconcile','run.resume') AND (status='accepted' OR (status='applied' AND json_extract(receipt_json,'$.preparingNextAttempt')=1)) ORDER BY seq LIMIT 4097",
      input.sessionId,
    );
    if (pendingCommands.length > 4096) throw new AgentError('recovery_too_large');
    for (const command of pendingCommands) {
      const receipt = command.receipt_json
        ? (JSON.parse(String(command.receipt_json)) as { [key: string]: Json })
        : {};
      if (command.status === 'accepted' || receipt.preparingNextAttempt === true) {
        db.run(
          "UPDATE command SET status='needs_review',receipt_json=? WHERE id=?",
          canonicalJson({
            ...receipt,
            preparingNextAttempt: false,
            recoveryCommandId: input.commandId,
          }),
          command.id,
        );
        db.event(String(command.session_id), String(command.id), 'command.needs_review');
      }
    }
    db.allocateSessionSequence(input.sessionId);
    const seq = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!.next_seq;
    db.run(
      "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,?,?,'session.recover',?,?,?,'applied',?,?,?)",
      input.commandId,
      input.sessionId,
      seq,
      input.subjectId,
      digest(input),
      canonicalJson(request(input)),
      input.expectedStoreId,
      input.commandId,
      seq,
    );
    db.event(input.sessionId, input.commandId, 'session.recovered');
    report.snapshotCursor = String(
      db.row('SELECT last_change_cursor FROM storage_meta WHERE singleton=1')!.last_change_cursor,
    );
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson(report as unknown as Json),
      input.commandId,
    );
    return report;
  });
}
