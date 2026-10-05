import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { AcceptAgentInput, InterruptAgentInput } from '../port';
import { AgentError, type CommandRecord, type Json } from '../types';
import { cancelWorkBody } from './cancel-operations';
import { verifyNamespace } from './extension-operations';
import { validateInputAdmission } from './input-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Private persisted provenance, sealed only by the owner admission transaction below. */
export function validateAgentSource(db: SqliteOperations, command: Row): void {
  if (command.agent_source_execution_id === null) return;
  const source = db.row(
    'SELECT e.*,c.subject_id,c.cancelled AS command_cancelled FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
    command.agent_source_execution_id!,
  );
  const session = db.row('SELECT * FROM session WHERE id=?', command.session_id!);
  const carrier = db.row(
    'SELECT * FROM execution WHERE id=? AND child_session_id=?',
    command.agent_carrier_execution_id!,
    command.session_id!,
  );
  if (
    !source ||
    !session ||
    !carrier ||
    session.parent_id !== source.session_id ||
    source.subject_id !== command.subject_id ||
    source.origin_store_id !== command.origin_store_id ||
    carrier.origin_store_id !== command.origin_store_id
  )
    throw new AgentError('operation_unverifiable');
  if (source.cancel_requested || source.command_cancelled) throw new AgentError('input_cancelled');
}
export function acceptAgentInput(db: SqliteOperations, input: AcceptAgentInput): CommandRecord {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.key)) throw new AgentError('invalid_operation_key');
    const origin = db.row(
      'SELECT * FROM command WHERE id=? AND session_id=?',
      input.originCommandId,
      input.sessionId,
    );
    const sender = db.row(
      'SELECT * FROM execution WHERE id=? AND session_id=?',
      input.parentExecutionId,
      input.sessionId,
    );
    if (
      !origin ||
      !sender ||
      sender.origin_command_id !== origin.id ||
      sender.origin_store_id !== input.expectedStoreId ||
      sender.kind !== 'tool'
    )
      throw new AgentError('invalid_operation_parent');
    db.active(input.owner, input.originCommandId);
    db.ancestors(input.owner, input.parentExecutionId);
    verifyNamespace(db, input.extensionId, origin, input.parentExecutionId);
    if (!['dispatching', 'running'].includes(String(sender.state)))
      throw new AgentError('invalid_operation_parent');
    const ref = input.ref;
    if (
      ref.extensionId !== input.extensionId ||
      ref.sessionId !== input.sessionId ||
      ref.originStoreId !== input.expectedStoreId
    )
      throw new AgentError('permission_denied');
    const operation = db.row(
      'SELECT * FROM command WHERE id=? AND session_id=? AND extension_id=? AND operation_key=?',
      ref.commandId,
      input.sessionId,
      input.extensionId,
      ref.key,
    );
    const carrier = ref.executionId
      ? db.row(
          'SELECT * FROM execution WHERE id=? AND origin_command_id=?',
          ref.executionId,
          ref.commandId,
        )
      : null;
    if (
      !operation ||
      !carrier?.child_session_id ||
      operation.subject_id !== origin.subject_id ||
      carrier.origin_store_id !== input.expectedStoreId ||
      (ref.childSessionId !== undefined && ref.childSessionId !== carrier.child_session_id)
    )
      throw new AgentError('operation_unverifiable');
    const child = db.row(
      'SELECT * FROM session WHERE id=? AND parent_id=? AND root_id=?',
      carrier.child_session_id!,
      input.sessionId,
      input.owner.sessionId,
    );
    if (!child || child.delete_requested) throw new AgentError('session_not_found');
    const content = canonicalJson({
      kind: 'agent_message',
      sourceSessionId: input.sessionId,
      sourceExecutionId: input.parentExecutionId,
      carrierExecutionId: String(carrier.id),
      content: input.content,
    });
    const request = {
      kind: 'input.steer' as const,
      targetRunId: input.targetRunId,
      contextSelectionId: input.contextSelectionId,
      content,
    };
    const requestDigest = digest(request);
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.request_digest !== requestDigest ||
        prior.session_id !== child.id ||
        prior.subject_id !== origin.subject_id ||
        prior.agent_source_execution_id !== sender.id ||
        prior.agent_carrier_execution_id !== carrier.id
      )
        throw new AgentError('command_conflict');
      return db.command(prior);
    }
    if (
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      Buffer.byteLength(input.content) > 1024 * 1024
    )
      throw new AgentError('invalid_input_request');
    const target = db.row(
      'SELECT * FROM run WHERE id=? AND session_id=?',
      input.targetRunId,
      child.id!,
    );
    const start = target && db.row('SELECT * FROM command WHERE id=?', target.origin_command_id!);
    if (
      !target ||
      !start ||
      start.id !== `child-start-${carrier.id}` ||
      !target.is_active ||
      target.cancel_requested ||
      carrier.cancel_requested ||
      !['dispatching', 'running'].includes(String(carrier.state))
    )
      throw new AgentError('input_target_stopped');
    db.active(input.owner, String(target.origin_command_id), String(target.id));
    db.ancestors(input.owner, String(carrier.id));
    const derived = {
      expectedStoreId: input.expectedStoreId,
      commandId: input.commandId,
      sessionId: String(child.id),
      subjectId: String(origin.subject_id),
      request,
    };
    const binding = validateInputAdmission(db, derived, true)!;
    db.insertCommand(
      derived as unknown as Parameters<SqliteOperations['insertCommand']>[0],
      request,
      requestDigest,
      'accepted',
      { commandId: input.commandId },
    );
    db.run(
      'UPDATE command SET input_target_run_id=?,input_context_selection_id=?,root_work_command_id=?,root_work_seq=?,agent_source_execution_id=?,agent_carrier_execution_id=? WHERE id=?',
      binding.targetRunId,
      binding.contextSelectionId,
      binding.rootWorkCommandId,
      binding.rootWorkSeq,
      sender.id,
      carrier.id,
      input.commandId,
    );
    db.event(String(child.id), input.commandId, 'command.accepted');
    return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
  });
}

export function interruptAgent(db: SqliteOperations, input: InterruptAgentInput): CommandRecord {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.commandId))
      throw new AgentError('invalid_command_id');
    const origin = db.row(
      'SELECT * FROM command WHERE id=? AND session_id=?',
      input.originCommandId,
      input.sessionId,
    );
    const sender = db.row(
      'SELECT * FROM execution WHERE id=? AND session_id=? AND origin_command_id=?',
      input.parentExecutionId,
      input.sessionId,
      input.originCommandId,
    );
    const ref = input.ref;
    if (
      !origin ||
      !sender ||
      sender.origin_store_id !== input.expectedStoreId ||
      sender.kind !== 'tool'
    )
      throw new AgentError('invalid_operation_parent');
    if (
      ref.originStoreId !== input.expectedStoreId ||
      ref.extensionId !== input.extensionId ||
      ref.sessionId !== input.sessionId
    )
      throw new AgentError('permission_denied');
    const operation = db.row(
      'SELECT * FROM command WHERE id=? AND session_id=? AND extension_id=? AND operation_key=?',
      ref.commandId,
      input.sessionId,
      input.extensionId,
      ref.key,
    );
    const carrier = ref.executionId
      ? db.row(
          'SELECT * FROM execution WHERE id=? AND origin_command_id=?',
          ref.executionId,
          ref.commandId,
        )
      : null;
    const child = carrier?.child_session_id
      ? db.row(
          'SELECT * FROM session WHERE id=? AND parent_id=? AND root_id=?',
          carrier.child_session_id,
          input.sessionId,
          input.owner.sessionId,
        )
      : null;
    if (
      !operation ||
      !carrier ||
      !child ||
      operation.subject_id !== origin.subject_id ||
      carrier.origin_store_id !== input.expectedStoreId ||
      (ref.childSessionId !== undefined && ref.childSessionId !== child.id)
    )
      throw new AgentError('operation_unverifiable');
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      const body = JSON.parse(String(prior.request_json)) as Record<string, Json>;
      if (
        prior.origin_store_id !== input.expectedStoreId ||
        prior.subject_id !== origin.subject_id ||
        prior.session_id !== child.id ||
        prior.agent_source_execution_id !== sender.id ||
        prior.agent_carrier_execution_id !== carrier.id ||
        body.kind !== 'run.cancel' ||
        body.runId !== input.targetRunId
      )
        throw new AgentError('command_conflict');
      return db.command(prior);
    }
    db.active(input.owner, input.originCommandId);
    db.ancestors(input.owner, input.parentExecutionId);
    verifyNamespace(db, input.extensionId, origin, input.parentExecutionId);
    if (!['dispatching', 'running'].includes(String(sender.state)))
      throw new AgentError('invalid_operation_parent');
    const run = db.row(
      'SELECT * FROM run WHERE id=? AND session_id=? AND is_active=1',
      input.targetRunId,
      child.id!,
    );
    const reference = JSON.parse(String(carrier.reference_json)) as { runId?: string } | null;
    if (
      !run ||
      run.origin_command_id !== `child-start-${carrier.id}` ||
      run.origin_store_id !== input.expectedStoreId ||
      reference?.runId !== run.id ||
      !['dispatching', 'running'].includes(String(carrier.state))
    )
      throw new AgentError('input_target_stopped');
    db.owner(input.owner, String(child.id));
    db.ancestors(input.owner, String(carrier.id));
    const cancelled = cancelWorkBody(db, {
      expectedStoreId: input.expectedStoreId,
      commandId: input.commandId,
      subjectId: String(origin.subject_id),
      sessionId: String(child.id),
      kind: 'run.cancel',
      runId: String(run.id),
    });
    db.run(
      'UPDATE command SET agent_source_execution_id=?,agent_carrier_execution_id=? WHERE id=?',
      sender.id,
      carrier.id,
      input.commandId,
    );
    return { ...cancelled };
  });
}
