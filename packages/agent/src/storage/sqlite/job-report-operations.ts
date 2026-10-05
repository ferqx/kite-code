import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { DispatchInput, Store } from '../port';
import { type AfterTurnAuthorization, AgentError, type Json } from '../types';
import { callContextSelection } from './context-selection-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { verifyHostControlDispatch } from './host-control-dispatch';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined) => JSON.parse(String(value)) as Record<string, Json>;
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Only an actual sealed report may retain its completed child origin as ancestry. */
export function childReportCarrier(db: SqliteOperations, report: Row): Row {
  const request = parse(report.request_json);
  const result = db.row('SELECT * FROM execution WHERE id=?', String(request.executionId));
  const binding = result?.after_turn_json ? parse(result.after_turn_json) : null;
  const parent =
    binding &&
    db.row(
      'SELECT * FROM run WHERE id=? AND session_id=?',
      String(binding.parentRunId),
      report.session_id!,
    );
  const start =
    parent &&
    db.row("SELECT * FROM command WHERE id=? AND kind='child.start'", parent.origin_command_id!);
  const startBody = start && parse(start.request_json);
  const carrier =
    startBody &&
    db.row(
      'SELECT * FROM execution WHERE id=? AND child_session_id=?',
      String(startBody.parentExecutionId),
      report.session_id!,
    );
  if (
    !result ||
    !binding ||
    !parent ||
    !start ||
    !carrier ||
    report.kind !== 'job.report' ||
    !['accepted', 'applied'].includes(String(report.status)) ||
    report.id !==
      `report-${digest([String(result.origin_store_id), String(result.id), String(result.result_revision)])}` ||
    report.session_id !== result.session_id ||
    parent.id !== request.parentRunId ||
    start.id !== `child-start-${carrier.id}` ||
    parent.status !== 'completed' ||
    parent.cancel_requested ||
    carrier.origin_store_id !== db.metadata().storeId ||
    carrier.cancel_requested ||
    !['succeeded', 'failed'].includes(String(carrier.state)) ||
    result.origin_store_id !== report.origin_store_id ||
    start.subject_id !== report.subject_id ||
    parent.root_work_command_id !== report.root_work_command_id ||
    String(parent.root_work_seq) !== String(report.root_work_seq) ||
    carrier.root_work_command_id !== report.root_work_command_id ||
    String(carrier.root_work_seq) !== String(report.root_work_seq)
  )
    throw new AgentError('report_unverifiable');
  return {
    ...carrier,
    report_deadline_at: parent.deadline_at ?? null,
    report_command_id: report.id!,
  };
}
export function validateAfterTurnAuthorization(
  db: SqliteOperations,
  parent: Row,
  authorization: AfterTurnAuthorization,
): void {
  if (
    !authorization ||
    Object.keys(authorization).some((key) => !['revision', 'controlReads'].includes(key)) ||
    typeof authorization.revision !== 'string' ||
    !authorization.revision ||
    authorization.revision.length > 4096
  )
    throw new AgentError('after_turn_authorization_invalid');
  verifyHostControlDispatch(db, parent, {
    expectedStoreId: String(parent.origin_store_id),
    authorization: {
      allowed: true,
      revision: authorization.revision,
      controlReads: authorization.controlReads,
    },
  } as DispatchInput);
}
export function sealAfterTurn(
  db: SqliteOperations,
  parent: Row,
  input: { afterTurnAuthorization?: AfterTurnAuthorization },
  configuration: Json,
): Json | null {
  if (!input.afterTurnAuthorization) return null;
  const session = db.row('SELECT * FROM session WHERE id=?', parent.session_id!);
  const run =
    parent.run_id !== null &&
    db.row('SELECT * FROM run WHERE id=? AND session_id=?', parent.run_id!, parent.session_id!);
  if (
    !session ||
    parent.kind !== 'tool' ||
    !run ||
    !run.is_active ||
    run.cancel_requested ||
    parent.cancel_requested
  )
    throw new AgentError('after_turn_scope_unsupported');
  const origin = db.row('SELECT kind FROM command WHERE id=?', run.origin_command_id!);
  if (!origin || !['run.start', 'input.follow_up', 'child.start'].includes(String(origin.kind)))
    throw new AgentError('after_turn_scope_unsupported');
  validateAfterTurnAuthorization(db, parent, input.afterTurnAuthorization);
  return {
    kind: 'after_turn',
    parentRunId: String(run.id),
    sourceExecutionId: String(parent.id),
    definitionId: String(parent.adapter_id),
    definitionVersion: String(parent.definition_version),
    inputDigest: digest(parse(parent.intent_json)),
    configuration,
    contextSelectionId: String(session.context_selection_id),
    authorization: input.afterTurnAuthorization as unknown as Json,
  };
}
function suppression(
  db: SqliteOperations,
  execution: Row,
  binding: Record<string, Json>,
): string | null {
  const session = db.row('SELECT * FROM session WHERE id=?', execution.session_id!);
  const parent = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    String(binding.parentRunId),
    execution.session_id!,
  );
  if (!session || session.delete_requested) return 'session_deleted';
  if (execution.origin_store_id !== db.metadata().storeId) return 'origin_store_changed';
  if (session.context_selection_id !== binding.contextSelectionId) return 'context_rewound';
  if (
    execution.cancel_requested ||
    BigInt(execution.root_work_seq!) <= BigInt(session.stop_boundary!)
  )
    return 'cancelled';
  if (execution.state === 'outcome_unknown') return 'outcome_unknown';
  if (!['succeeded', 'failed', 'cancelled'].includes(String(execution.state)))
    return 'result_unsettled';
  if (
    !parent ||
    parent.origin_store_id !== execution.origin_store_id ||
    parent.root_work_command_id !== execution.root_work_command_id ||
    String(parent.root_work_seq) !== String(execution.root_work_seq)
  )
    return 'parent_unverifiable';
  if (
    parent.cancel_requested ||
    ['failed', 'cancelled', 'interrupted'].includes(String(parent.status))
  )
    return 'parent_stopped';
  if (parent.deadline_at !== null && BigInt(parent.deadline_at!) <= BigInt(Date.now()))
    return 'child_deadline_exceeded';
  if (execution.delivery !== 'pending') return 'result_not_pending';
  if (
    db.row(
      "SELECT id FROM command WHERE session_id=? AND seq>(SELECT seq FROM command WHERE id=?) AND kind IN('run.start','input.follow_up','extension.invoke','child.start') AND cancelled=0 AND status IN('accepted','applied') LIMIT 1",
      execution.session_id!,
      parent.origin_command_id!,
    )
  )
    return 'human_start_preferred';
  return null;
}
export function registerJobReport(db: SqliteOperations, executionId: string): void {
  const execution = db.row('SELECT * FROM execution WHERE id=?', executionId);
  if (!execution?.after_turn_json) return;
  const binding = parse(execution.after_turn_json),
    origin = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!)!;
  const commandId = `report-${digest([String(execution.origin_store_id), executionId, String(execution.result_revision)])}`;
  if (db.row('SELECT id FROM command WHERE id=?', commandId)) return;
  const reason = suppression(db, execution, binding);
  const request: Json = {
    kind: 'job.report',
    executionId,
    resultRevision: String(execution.result_revision),
    contextSelectionId: binding.contextSelectionId!,
    parentRunId: binding.parentRunId!,
    authorization: binding.authorization!,
  };
  db.insertCommand(
    {
      expectedStoreId: String(execution.origin_store_id),
      commandId,
      sessionId: String(execution.session_id),
      subjectId: String(origin.subject_id),
    } as Parameters<SqliteOperations['insertCommand']>[0],
    request,
    digest(request),
    reason ? 'rejected' : 'accepted',
    {
      executionId,
      outcome: reason ? 'suppressed' : 'report_pending',
      ...(reason ? { reason } : {}),
    },
  );
  db.run(
    'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
    execution.root_work_command_id!,
    execution.root_work_seq!,
    commandId,
  );
  if (reason && execution.delivery === 'pending')
    db.run(
      "UPDATE execution SET delivery='suppressed',delivery_reason=? WHERE id=?",
      reason,
      executionId,
    );
  db.event(String(execution.session_id), commandId, 'job.report_registered');
}
export function listPendingJobReports(
  db: SqliteOperations,
  input: Parameters<Store['listPendingJobReports']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const decimal = (value: string) => {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
        throw new AgentError('invalid_cursor');
      return BigInt(value);
    };
    const water = String(
        db.row(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM command WHERE session_id=? AND kind='job.report'",
          input.sessionId,
        )!.seq,
      ),
      upper = decimal(input.upperSeq ?? water),
      after = decimal(input.afterSeq ?? '0'),
      limit = input.limit ?? 50;
    if (after > upper || upper > decimal(water)) throw new AgentError('cursor_ahead');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentError('invalid_limit');
    const rows = db.rows(
        "SELECT * FROM command WHERE session_id=? AND kind='job.report' AND status='accepted' AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
        input.sessionId,
        after,
        upper,
        limit + 1,
      ),
      page = rows.slice(0, limit);
    const result = {
      commands: page.map((row) => db.command(row)),
      upperSeq: String(upper),
      highWaterSeq: water,
      nextAfterSeq: rows.length > limit ? String(page.at(-1)!.seq) : null,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export interface JobReportRecovery {
  commandId: string;
  subjectId: string;
  expectedConfiguration: Json;
}
function prepareReportRecovery(db: SqliteOperations, report: Row, recovery: JobReportRecovery) {
  if (
    !recovery ||
    Object.keys(recovery).some(
      (key) => !['commandId', 'subjectId', 'expectedConfiguration'].includes(key),
    ) ||
    typeof recovery.commandId !== 'string' ||
    !recovery.commandId ||
    recovery.commandId.length > 256 ||
    typeof recovery.subjectId !== 'string' ||
    !recovery.subjectId ||
    recovery.subjectId.length > 256 ||
    !Object.hasOwn(recovery, 'expectedConfiguration') ||
    recovery.expectedConfiguration === undefined
  )
    throw new AgentError('invalid_report_recovery');
  const session = db.row('SELECT * FROM session WHERE id=?', report.session_id!);
  if (!session || session.parent_id !== null || session.root_id !== session.id)
    throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    report.session_id!,
  );
  if (creator?.subject_id !== recovery.subjectId || report.subject_id !== recovery.subjectId)
    throw new AgentError('permission_denied');
  const request: Json = {
    kind: 'job.report.resume',
    originalReportCommandId: String(report.id),
    expectedConfiguration: recovery.expectedConfiguration,
  };
  const prior = db.row('SELECT * FROM command WHERE id=?', recovery.commandId);
  if (prior) {
    if (
      prior.kind !== 'job.report.resume' ||
      prior.session_id !== report.session_id ||
      prior.subject_id !== recovery.subjectId ||
      prior.origin_store_id !== report.origin_store_id ||
      prior.request_digest !== digest(request) ||
      prior.status !== 'applied'
    )
      throw new AgentError('command_conflict');
    return { request, prior: true };
  }
  if (!['accepted', 'applied', 'needs_review'].includes(String(report.status)))
    throw new AgentError('report_recovery_unavailable');
  if (report.status === 'needs_review') {
    const receipt = parse(report.receipt_json);
    const recovered =
      typeof receipt.recoveryCommandId === 'string'
        ? db.row(
            "SELECT * FROM command WHERE id=? AND kind='session.recover' AND status='applied'",
            receipt.recoveryCommandId,
          )
        : null;
    const recoveredReceipt = recovered ? parse(recovered.receipt_json) : null;
    const recoveredRequest = recovered ? parse(recovered.request_json) : null;
    const legitimateRecovery =
      recovered &&
      recovered.session_id === report.session_id &&
      recovered.origin_store_id === report.origin_store_id &&
      recovered.subject_id === recovery.subjectId &&
      BigInt(recovered.seq!) > BigInt(report.seq!) &&
      recoveredRequest?.decision === 'interrupt' &&
      recoveredReceipt?.sessionId === report.session_id &&
      recoveredReceipt?.storeId === report.origin_store_id;
    if (receipt.reason !== 'report_recovery_required' && !legitimateRecovery)
      throw new AgentError('report_recovery_unavailable');
  }
  const body = parse(report.request_json);
  const parent = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    String(body.parentRunId),
    report.session_id!,
  );
  if (!parent || parent.origin_store_id !== report.origin_store_id)
    throw new AgentError('report_unverifiable');
  if (canonicalJson(recovery.expectedConfiguration) !== canonicalJson(parse(parent.config_json)))
    throw new AgentError('report_configuration_mismatch');
  return { request, prior: false };
}
/** Verify recovery admission before restoring any host resources; apply still repeats all checks. */
export function verifyJobReportRecovery(
  db: SqliteOperations,
  input: Parameters<Store['verifyJobReportRecovery']>[0],
): void {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const report = db.row(
      "SELECT * FROM command WHERE id=? AND kind='job.report'",
      input.reportCommandId,
    );
    if (
      !report ||
      report.session_id !== input.sessionId ||
      report.origin_store_id !== input.expectedStoreId
    )
      throw new AgentError('report_recovery_unavailable');
    prepareReportRecovery(db, report, input.recovery);
    db.db.run('COMMIT');
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
function recordReportRecovery(
  db: SqliteOperations,
  report: Row,
  recovery: JobReportRecovery | undefined,
  prepared: { request: Json; prior: boolean } | undefined,
  run: Row | null,
  reason?: string,
) {
  if (!recovery || !prepared || prepared.prior) return;
  db.insertCommand(
    {
      expectedStoreId: String(report.origin_store_id),
      commandId: recovery.commandId,
      sessionId: String(report.session_id),
      subjectId: recovery.subjectId,
    } as Parameters<SqliteOperations['insertCommand']>[0],
    prepared.request,
    digest(prepared.request),
    'applied',
    {
      reportCommandId: String(report.id),
      runId: run ? String(run.id) : null,
      outcome: reason ? 'report_suppressed' : 'report_resumed',
      ...(reason ? { reason } : {}),
    },
  );
  db.event(String(report.session_id), recovery.commandId, 'job.report_recovered');
}
export function applyJobReport(
  db: SqliteOperations,
  input: Parameters<Store['applyJobReport']>[0] & { recovery?: JobReportRecovery },
) {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const command = db.row(
      "SELECT * FROM command WHERE id=? AND kind='job.report'",
      input.commandId,
    );
    if (!command) throw new AgentError('command_not_found');
    db.owner(input.owner, String(command.session_id));
    if (command.origin_store_id !== input.expectedStoreId)
      throw new AgentError('operation_unverifiable');
    const prepared = input.recovery
      ? prepareReportRecovery(db, command, input.recovery)
      : undefined;
    if (
      prepared?.prior ||
      command.status === 'applied' ||
      (command.status !== 'accepted' && !input.recovery)
    ) {
      const run = db.row('SELECT * FROM run WHERE origin_command_id=?', command.id!);
      recordReportRecovery(db, command, input.recovery, prepared, run);
      return { command: db.command(command), run: run ? db.runRecord(run) : null, started: false };
    }
    const request = parse(command.request_json),
      execution = db.row('SELECT * FROM execution WHERE id=?', String(request.executionId));
    if (!execution?.after_turn_json || String(execution.result_revision) !== request.resultRevision)
      throw new AgentError('report_unverifiable');
    const binding = parse(execution.after_turn_json),
      parent = db.row('SELECT * FROM run WHERE id=?', String(binding.parentRunId)),
      source = db.row('SELECT * FROM execution WHERE id=?', String(binding.sourceExecutionId));
    let reason = command.cancelled ? 'cancelled' : suppression(db, execution, binding);
    if (
      !input.authorization ||
      canonicalJson(input.authorization as unknown as Json) !==
        canonicalJson(binding.authorization!)
    )
      reason ??= 'after_turn_policy_changed';
    if (
      !source ||
      !parent ||
      (input.recovery &&
        (command.id !==
          `report-${digest([String(execution.origin_store_id), String(execution.id), String(execution.result_revision)])}` ||
          parent.id !== request.parentRunId ||
          parent.session_id !== execution.session_id ||
          request.contextSelectionId !== binding.contextSelectionId ||
          canonicalJson(request.authorization!) !== canonicalJson(binding.authorization!) ||
          db.row('SELECT subject_id FROM command WHERE id=?', parent.origin_command_id!)
            ?.subject_id !== command.subject_id)) ||
      execution.parent_execution_id !== source.id ||
      source.run_id !== parent.id ||
      source.session_id !== execution.session_id ||
      source.origin_store_id !== execution.origin_store_id ||
      source.root_work_command_id !== execution.root_work_command_id ||
      String(source.root_work_seq) !== String(execution.root_work_seq) ||
      command.session_id !== execution.session_id ||
      command.root_work_command_id !== execution.root_work_command_id ||
      String(command.root_work_seq) !== String(execution.root_work_seq) ||
      canonicalJson(parse(execution.child_configuration_json)) !==
        canonicalJson(binding.configuration!) ||
      source.adapter_id !== binding.definitionId ||
      source.definition_version !== binding.definitionVersion ||
      digest(parse(source.intent_json)) !== binding.inputDigest ||
      source.state !== 'succeeded' ||
      source.cancel_requested
    )
      reason ??= 'source_unverifiable';
    if (!reason && source && input.authorization) {
      try {
        validateAfterTurnAuthorization(db, source, input.authorization);
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'permission_control_changed')
          throw error;
        reason = 'permission_control_changed';
      }
    }
    if (reason) {
      db.run(
        "UPDATE command SET status='rejected',receipt_json=? WHERE id=?",
        canonicalJson({ executionId: request.executionId!, outcome: 'suppressed', reason }),
        command.id!,
      );
      if (execution.delivery === 'pending')
        db.run(
          "UPDATE execution SET delivery='suppressed',delivery_reason=? WHERE id=?",
          reason,
          execution.id!,
        );
      db.event(String(command.session_id), String(command.id), 'job.report_suppressed');
      recordReportRecovery(db, command, input.recovery, prepared, null, reason);
      return {
        command: db.command(db.row('SELECT * FROM command WHERE id=?', command.id!)!),
        run: null,
        started: false,
      };
    }
    if (!parent || parent.is_active || parent.status !== 'completed')
      throw new AgentError('report_parent_active', undefined, true);
    if (db.row('SELECT id FROM run WHERE session_id=? AND is_active=1', command.session_id!))
      throw new AgentError('session_busy');
    db.active(input.owner, String(command.id));
    assertNoExecutionGroupFence(db, String(command.session_id));
    const runId = randomUUID();
    db.run(
      "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,requirements_json,started_at,deadline_at,context_selection_id) VALUES(?,?,?,?,?,?,'running',1,?,?,?,?,?)",
      runId,
      command.session_id!,
      command.id!,
      command.origin_store_id!,
      command.root_work_command_id!,
      command.root_work_seq!,
      parent.config_json!,
      parent.requirements_json!,
      Date.now(),
      parent.deadline_at!,
      db.row('SELECT context_selection_id FROM session WHERE id=?', command.session_id!)!
        .context_selection_id,
    );
    db.run(
      "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
      canonicalJson({ runId, executionId: String(execution.id), outcome: 'report_started' }),
      command.id!,
    );
    callContextSelection(
      db,
      'consumeJobResult',
      [
        {
          expectedStoreId: input.expectedStoreId,
          owner: input.owner,
          commandId: `consume-${command.id}`,
          sessionId: String(command.session_id),
          executionId: String(execution.id),
          resultRevision: String(execution.result_revision),
          contextSelectionId: String(binding.contextSelectionId),
          targetRunId: runId,
        },
      ],
      true,
    );
    db.event(String(command.session_id), runId, 'run.started');
    recordReportRecovery(
      db,
      command,
      input.recovery,
      prepared,
      db.row('SELECT * FROM run WHERE id=?', runId),
    );
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', command.id!)!),
      run: db.runRecord(db.row('SELECT * FROM run WHERE id=?', runId)!),
      started: true,
    };
  });
}
