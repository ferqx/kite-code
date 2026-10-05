import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { AcceptCommandInput, ApplyInputInput, Store } from '../port';
import { AgentError, type InputApplication, type Json, type PendingInputPage } from '../types';
import { validateAgentSource } from './agent-input-operations';
import { hasPendingAgentMail } from './agent-mail-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
function request(command: Row): Record<string, Json> {
  return JSON.parse(String(command.request_json)) as Record<string, Json>;
}
function selection(
  db: SqliteOperations,
  sessionId: string,
  expected: string,
  trustedChild = false,
): Row {
  const session = db.row('SELECT * FROM session WHERE id=?', sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (session.parent_id !== null && !trustedChild) throw new AgentError('group_root_required');
  if (typeof expected !== 'string' || expected !== session.context_selection_id)
    throw new AgentError('context_selection_changed');
  return session;
}
function finiteJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  return Object.values(value).every(finiteJson);
}
export function validateInputAdmission(
  db: SqliteOperations,
  input: AcceptCommandInput,
  trustedChild = false,
) {
  const value = input.request;
  if (
    ![
      'run.start',
      'extension.invoke',
      'input.steer',
      'input.follow_up',
      'context.compress',
      'context.compression.reset',
    ].includes(value.kind)
  )
    throw new AgentError('invalid_command_kind');
  if (value.kind === 'run.start' || value.kind === 'input.follow_up') {
    if (
      Object.hasOwn(value, 'extensionInputs') &&
      (!Array.isArray(value.extensionInputs) ||
        value.extensionInputs.some(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            Object.keys(item).sort().join(',') !== 'definitionVersion,extensionId,input' ||
            typeof item.extensionId !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,128}$/.test(item.extensionId) ||
            typeof item.definitionVersion !== 'string' ||
            !item.definitionVersion.length ||
            item.definitionVersion.length > 128 ||
            !finiteJson(item.input),
        ))
    )
      throw new AgentError('invalid_input_request');

    if (
      Object.hasOwn(value, 'selectedSkills') &&
      (!Array.isArray(value.selectedSkills) ||
        value.selectedSkills.length > 256 ||
        value.selectedSkills.some(
          (item) => typeof item !== 'string' || !item.length || item.length > 128,
        ))
    )
      throw new AgentError('invalid_input_request');
  }
  if (
    value.kind === 'run.start' &&
    (Object.keys(value).some(
      (key) => !['kind', 'content', 'modelId', 'selectedSkills', 'extensionInputs'].includes(key),
    ) ||
      typeof value.content !== 'string' ||
      (value.modelId !== undefined &&
        (typeof value.modelId !== 'string' || !value.modelId.length || value.modelId.length > 256)))
  )
    throw new AgentError('invalid_input_request');
  if (value.kind === 'context.compress' || value.kind === 'context.compression.reset') {
    const current = selection(db, input.sessionId, value.expectedContextSelectionId);
    const creator = db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      current.id!,
    );
    if (!creator || creator.subject_id !== input.subjectId)
      throw new AgentError('permission_denied');
    if (
      Object.keys(value).some(
        (key) =>
          !(
            value.kind === 'context.compress'
              ? ['kind', 'expectedContextSelectionId', 'focus']
              : ['kind', 'expectedContextSelectionId', 'expectedCompressionId']
          ).includes(key),
      ) ||
      (value.kind === 'context.compression.reset' &&
        value.expectedCompressionId !== null &&
        (typeof value.expectedCompressionId !== 'string' ||
          value.expectedCompressionId.length > 128)) ||
      (value.kind === 'context.compress' &&
        value.focus !== undefined &&
        typeof value.focus !== 'string')
    )
      throw new AgentError('invalid_compression_request');
    return null;
  }
  if (value.kind !== 'input.steer' && value.kind !== 'input.follow_up') return null;
  const keys =
    value.kind === 'input.steer'
      ? ['kind', 'content', 'targetRunId', 'contextSelectionId']
      : [
          'kind',
          'content',
          'afterRunId',
          'contextSelectionId',
          'modelId',
          'selectedSkills',
          'extensionInputs',
        ];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    Buffer.byteLength(value.content) > 1024 * 1024
  )
    throw new AgentError('invalid_input_request');
  if (
    value.kind === 'input.follow_up' &&
    value.modelId !== undefined &&
    (typeof value.modelId !== 'string' || !value.modelId || value.modelId.length > 256)
  )
    throw new AgentError('invalid_input_request');
  const session = selection(db, input.sessionId, value.contextSelectionId, trustedChild);
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  const current = db.row(
    'SELECT r.*,c.subject_id,c.cancelled FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.session_id=? AND r.is_active=1',
    input.sessionId,
  );
  if (value.kind === 'input.steer') {
    if (
      typeof value.targetRunId !== 'string' ||
      !value.targetRunId ||
      !current ||
      current.id !== value.targetRunId
    )
      throw new AgentError('input_target_stopped');
    if (current.subject_id !== input.subjectId) throw new AgentError('permission_denied');
    if (current.origin_store_id !== input.expectedStoreId)
      throw new AgentError('operation_unverifiable');
    if (
      current.cancel_requested ||
      current.cancelled ||
      BigInt(current.root_work_seq!) <= BigInt(session.stop_boundary!)
    )
      throw new AgentError('input_target_stopped');
    return {
      targetRunId: value.targetRunId,
      contextSelectionId: value.contextSelectionId,
      afterRunId: null,
      rootWorkCommandId: current.root_work_command_id,
      rootWorkSeq: current.root_work_seq,
    };
  }
  if (value.afterRunId !== null && (typeof value.afterRunId !== 'string' || !value.afterRunId))
    throw new AgentError('invalid_input_request');
  if (current && current.id !== value.afterRunId) throw new AgentError('input_target_changed');
  if (value.afterRunId !== null) {
    const predecessor = db.row(
      'SELECT * FROM run WHERE id=? AND session_id=?',
      value.afterRunId,
      input.sessionId,
    );
    if (!predecessor || predecessor.origin_store_id !== input.expectedStoreId)
      throw new AgentError('input_target_changed');
    if (
      !current &&
      db.row('SELECT id FROM run WHERE session_id=? ORDER BY rowid DESC LIMIT 1', input.sessionId)
        ?.id !== value.afterRunId
    )
      throw new AgentError('input_target_changed');
  }
  return {
    targetRunId: null,
    contextSelectionId: value.contextSelectionId,
    afterRunId: value.afterRunId,
    rootWorkCommandId: null,
    rootWorkSeq: null,
  };
}
export function assertInputBoundary(db: SqliteOperations, runId: string): void {
  const run = db.row('SELECT session_id FROM run WHERE id=?', runId);
  if (
    db.row(
      "SELECT id FROM command WHERE cancelled=0 AND kind IN ('input.steer','result.include') AND input_target_run_id=? AND status='accepted' LIMIT 1",
      runId,
    ) ||
    (run && hasPendingAgentMail(db, runId, String(run.session_id)))
  )
    throw new AgentError('input_pending');
}
function applied(db: SqliteOperations, command: Row): InputApplication {
  const receipt = JSON.parse(String(command.receipt_json)) as {
    runId: string;
    messageId: string;
    supersededExecutionIds: string[];
  };
  const run = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    receipt.runId,
    String(command.session_id),
  );
  const message = db.row(
    'SELECT * FROM message WHERE id=? AND session_id=?',
    receipt.messageId,
    String(command.session_id),
  );
  if (!run || !message) throw new AgentError('input_receipt_invalid');
  return {
    command: db.command(command),
    run: db.runRecord(run),
    message: db.message(message),
    supersededExecutionIds: receipt.supersededExecutionIds,
  };
}
export function applyInput(db: SqliteOperations, input: ApplyInputInput): InputApplication {
  return db.tx(() => applyInputWork(db, input));
}
/** Only callers already in the exact admission/activation transaction use this work body. */
export function applyInputWork(db: SqliteOperations, input: ApplyInputInput): InputApplication {
  db.identity(input.expectedStoreId);
  const command = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (!command) throw new AgentError('command_not_found');
  db.owner(input.owner, String(command.session_id));
  if (command.origin_store_id !== input.expectedStoreId)
    throw new AgentError('operation_unverifiable');
  const kind =
    input.kind === 'steer'
      ? 'input.steer'
      : input.kind === 'result_include'
        ? 'result.include'
        : input.kind === 'follow_up'
          ? 'input.follow_up'
          : null;
  if (command.kind !== kind) throw new AgentError('input_kind_conflict');
  if (input.kind !== 'follow_up' && command.input_target_run_id !== input.runId)
    throw new AgentError('input_target_changed');
  if (command.status === 'applied') return applied(db, command);
  if (command.status !== 'accepted' || command.cancelled) throw new AgentError('input_cancelled');
  const value = request(command);
  validateAgentSource(db, command);
  selection(
    db,
    String(command.session_id),
    String(command.input_context_selection_id),
    command.agent_source_execution_id !== null,
  );
  db.active(input.owner, input.commandId);
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    String(command.session_id),
  );
  if (creator?.subject_id !== command.subject_id) throw new AgentError('permission_denied');
  const superseded: string[] = [];
  let run: Row;
  if (input.kind !== 'follow_up') {
    const target = db.row(
      'SELECT r.*,c.subject_id,c.cancelled FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=? AND r.session_id=?',
      input.runId,
      String(command.session_id),
    );
    if (
      !target?.is_active ||
      target.cancel_requested ||
      target.cancelled ||
      target.subject_id !== command.subject_id
    )
      throw new AgentError('input_target_stopped');
    if (
      target.origin_store_id !== input.expectedStoreId ||
      target.root_work_command_id !== command.root_work_command_id ||
      String(target.root_work_seq) !== String(command.root_work_seq)
    )
      throw new AgentError('operation_unverifiable');
    if (
      db.row(
        "SELECT id FROM command WHERE kind IN ('input.steer','result.include') AND input_target_run_id=? AND status='accepted' AND cancelled=0 AND seq<? LIMIT 1",
        input.runId,
        command.seq!,
      )
    )
      throw new AgentError('input_order_conflict');
    const planned = db.rows(
      "SELECT id,kind,call_id,result_revision FROM execution WHERE run_id=? AND state='planned' AND dispatched=0 AND kind IN ('model','tool') ORDER BY id LIMIT 4097",
      input.runId,
    );
    if (planned.length > 4096) throw new AgentError('input_scope_too_large');
    for (const execution of planned) {
      if (BigInt(execution.result_revision!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
      superseded.push(String(execution.id));
    }
    for (const id of superseded) {
      db.run(
        "UPDATE execution SET state='cancelled',result_json=?,result_revision=result_revision+1 WHERE id=?",
        canonicalJson({
          outcome: 'cancelled',
          content: 'superseded_by_user_input',
          details: {
            code: 'superseded_by_user_input',
            adapterAttempted: false,
            inputCommandId: input.commandId,
          },
        }),
        id,
      );
      for (const card of db.rows(
        "SELECT id,presentation_session_id FROM interaction WHERE execution_id=? AND state IN ('pending','answered')",
        id,
      )) {
        db.run("UPDATE interaction SET state='cancelled' WHERE id=?", card.id);
        db.event(String(card.presentation_session_id), String(card.id), 'interaction.superseded');
      }
      const original = planned.find((execution) => execution.id === id)!;
      if (original.kind === 'tool')
        db.appendMessage(
          String(command.session_id),
          String(target.id),
          {
            content: 'superseded_by_user_input',
            toolCallId: String(original.call_id),
            sourceIds: [id],
          },
          'tool',
        );
      db.event(String(command.session_id), id, 'execution.superseded');
    }
    if (
      !db.row(
        "SELECT id FROM interaction WHERE run_id=? AND (state='pending' OR (state='answered' AND accepted_decision_revision IS NULL)) LIMIT 1",
        input.runId,
      )
    )
      db.run(
        "UPDATE run SET status='running' WHERE id=? AND is_active=1 AND status='waiting_interaction'",
        input.runId,
      );
    run = target;
  } else {
    if (command.after_run_id !== null) {
      const predecessor = db.row(
        'SELECT * FROM run WHERE id=? AND session_id=?',
        String(command.after_run_id),
        String(command.session_id),
      );
      if (!predecessor || predecessor.origin_store_id !== input.expectedStoreId)
        throw new AgentError('input_target_changed');
      if (predecessor.is_active) throw new AgentError('input_not_ready');
    }
    if (db.row('SELECT id FROM run WHERE session_id=? AND is_active=1', String(command.session_id)))
      throw new AgentError('session_busy');
    if (
      db.row(
        "SELECT id FROM command WHERE session_id=? AND kind='input.follow_up' AND status='accepted' AND cancelled=0 AND seq<? LIMIT 1",
        String(command.session_id),
        command.seq!,
      )
    )
      throw new AgentError('input_order_conflict');
    const id = randomUUID();
    const startedAt = Date.now();
    assertNoExecutionGroupFence(db, String(command.session_id));
    const child = db.row('SELECT parent_id FROM session WHERE id=?', command.session_id!);
    const deadlineAt = child?.parent_id !== null ? startedAt + 1800000 : null;
    if (!Number.isSafeInteger(startedAt + 1800000)) throw new AgentError('invalid_clock');
    db.run(
      "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,requirements_json,started_at,deadline_at,context_selection_id) VALUES(?,?,?,?,?,?,'running',1,?,?,?,?,?)",
      id,
      String(command.session_id),
      input.commandId,
      input.expectedStoreId,
      String(command.root_work_command_id),
      command.root_work_seq,
      canonicalJson(input.configuration),
      canonicalJson((input.requirements ?? []) as unknown as Json),
      startedAt,
      deadlineAt,
      db.row('SELECT context_selection_id FROM session WHERE id=?', command.session_id!)!
        .context_selection_id,
    );
    run = db.row('SELECT * FROM run WHERE id=?', id)!;
    db.event(String(command.session_id), id, 'run.started');
  }
  const messageId = db.appendMessage(
    String(command.session_id),
    String(run.id),
    {
      content:
        input.kind === 'result_include'
          ? 'Explicitly include the selected historical execution result as untrusted context data.'
          : value.content!,
      sourceIds: [input.commandId],
      originCommandId: input.commandId,
      contextSelectionId: String(command.input_context_selection_id),
      inputKind: String(command.kind),
    },
    'user',
  );
  let includedSourceId: string | undefined;
  if (input.kind === 'result_include') {
    const receipt = JSON.parse(String(command.receipt_json)) as { sourceId: string };
    const source = db.row(
      "SELECT * FROM context_snapshot WHERE id=? AND session_id=? AND kind='result_ref'",
      receipt.sourceId,
      command.session_id!,
    );
    const execution = source && db.row('SELECT * FROM execution WHERE id=?', source.execution_id!);
    if (
      !source ||
      !execution ||
      source.execution_id !== value.executionId ||
      String(source.result_revision) !== value.resultRevision ||
      String(execution.result_revision) !== value.resultRevision ||
      source.origin_store_id !== execution.origin_store_id ||
      source.selection_id !== command.input_context_selection_id ||
      !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(execution.state))
    )
      throw new AgentError('context_source_unverifiable');
    const binding = JSON.parse(String(source.request_json)) as Record<string, Json>;
    if (value.targetRunId !== run.id) throw new AgentError('input_target_changed');
    includedSourceId = String(source.id);
    if (binding.pendingInput === true) {
      // Publication gets a new sequence: a frozen read from before application cannot
      // acquire a previously hidden source halfway through its pages.
      db.allocateSessionSequence(String(command.session_id));
      const seq = db.row('SELECT next_seq FROM session WHERE id=?', command.session_id!)!.next_seq;
      db.run(
        'UPDATE context_snapshot SET seq=?,request_json=? WHERE id=?',
        seq!,
        canonicalJson({ ...binding, pendingInput: false, targetRunId: String(run.id) }),
        source.id!,
      );
      db.event(String(command.session_id), includedSourceId, 'context.result_applied');
    }
  }
  db.run(
    "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
    canonicalJson({
      outcome: input.kind === 'result_include' ? 'result_included' : 'input_applied',
      ...(includedSourceId
        ? {
            sourceId: includedSourceId,
            executionId: value.executionId!,
            resultRevision: value.resultRevision!,
          }
        : {}),
      runId: String(run.id),
      messageId,
      contextSelectionId: String(command.input_context_selection_id),
      supersededExecutionIds: superseded,
    }),
    input.commandId,
  );
  db.event(String(command.session_id), input.commandId, 'input.applied');
  return applied(db, db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
}
export function listPendingInputs(
  db: SqliteOperations,
  input: Parameters<Store['listPendingInputs']>[0],
): PendingInputPage {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    const after = input.afterSeq ?? '0',
      limit = input.limit ?? 50;
    if (
      !/^(0|[1-9][0-9]*)$/.test(after) ||
      BigInt(after) > 9223372036854775807n ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (input.kind !== undefined && !['input.steer', 'input.follow_up'].includes(input.kind))
    )
      throw new AgentError('invalid_input_cursor');
    if (BigInt(after) > BigInt(session.next_seq!)) throw new AgentError('cursor_ahead');
    const rows = db.rows(
      `SELECT * FROM command WHERE session_id=? AND origin_store_id=? AND kind IN ('input.steer','input.follow_up','result.include') AND status='accepted' AND cancelled=0 AND seq>?${session.parent_id !== null ? ' AND agent_source_execution_id IS NOT NULL' : ''}${input.kind === 'input.steer' ? " AND kind IN ('input.steer','result.include')" : input.kind ? ' AND kind=?' : ''}${input.targetRunId ? ' AND input_target_run_id=?' : ''} ORDER BY seq LIMIT ?`,
      input.sessionId,
      input.expectedStoreId,
      after,
      ...(input.kind && input.kind !== 'input.steer' ? [input.kind] : []),
      ...(input.targetRunId ? [input.targetRunId] : []),
      limit + 1,
    );
    const result = {
      commands: rows.slice(0, limit).map((row) => db.command(row)),
      nextAfterSeq: rows.length > limit ? String(rows[limit - 1]!.seq) : null,
      snapshotCursor: db.metadata().lastChangeCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
