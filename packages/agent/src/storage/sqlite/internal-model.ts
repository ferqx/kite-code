import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import { bodyReference } from '../../model-body';
import type { Store } from '../port';
import { AgentError, type Json } from '../types';
import { assertCurrentChildPurpose } from './child-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { verifyHostControlReads } from './host-control-dispatch';
import { assertHumanWorkDispatch } from './human-work-control';
import { verifyModelBody } from './model-body';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const hash = (v: Json) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const object = (v: unknown): Record<string, Json> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new AgentError('internal_model_unverifiable');
  return v as Record<string, Json>;
};
/** Exact host-owned naming purpose, never a general runless Model capability. */
export function internalModelSourceTarget(db: SqliteOperations, execution: Row): Row | null {
  try {
    const command = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
    const parent =
      execution.parent_execution_id &&
      db.row('SELECT * FROM execution WHERE id=?', execution.parent_execution_id);
    if (
      !command ||
      !parent ||
      command.kind !== 'session.title' ||
      command.status !== 'applied' ||
      command.extension_id !== '__internal_model__' ||
      command.scope_kind !== 'execution' ||
      command.scope_id !== parent.id ||
      execution.kind !== 'model' ||
      execution.run_id !== null ||
      execution.child_session_id !== null ||
      execution.child_configuration_json !== null ||
      !execution.cancel_with_parent ||
      parent.adapter_id !== 'builtin.session-title/generate' ||
      parent.definition_version !== '1' ||
      !parent.dispatched ||
      !['tool', 'job'].includes(String(parent.kind)) ||
      execution.session_id !== parent.session_id ||
      command.session_id !== parent.session_id ||
      execution.origin_store_id !== parent.origin_store_id ||
      command.origin_store_id !== parent.origin_store_id ||
      execution.root_session_id !== parent.root_session_id ||
      execution.root_work_command_id !== parent.root_work_command_id ||
      execution.root_work_seq !== parent.root_work_seq ||
      command.root_work_command_id !== parent.root_work_command_id ||
      command.root_work_seq !== parent.root_work_seq ||
      execution.owner_generation !== parent.owner_generation ||
      execution.decision_source_json !== parent.decision_source_json ||
      execution.requirements_json !== '[]' ||
      Number(execution.attempt) !== 1
    )
      return null;
    const models = db.rows(
      'SELECT id FROM execution WHERE origin_command_id=? LIMIT 2',
      command.id!,
    );
    if (models.length !== 1 || models[0]!.id !== execution.id) return null;
    const parentOrigin = db.row('SELECT * FROM command WHERE id=?', parent.origin_command_id!);
    const request = object(JSON.parse(String(command.request_json))),
      receipt = object(JSON.parse(String(command.receipt_json))),
      intent = object(verifyModelBody(db, JSON.parse(String(execution.intent_json)), execution));
    if (
      !parentOrigin ||
      parentOrigin.subject_id !== command.subject_id ||
      request.kind !== 'session.title' ||
      request.parentExecutionId !== parent.id ||
      command.request_digest !== hash(request) ||
      receipt.executionId !== execution.id ||
      receipt.commandId !== command.id ||
      receipt.preparedInputDigest !== hash(intent) ||
      canonicalJson(request.request!) !== canonicalJson(intent) ||
      canonicalJson(intent.tools ?? []) !== '[]' ||
      intent.requestId !== execution.id ||
      typeof intent.modelId !== 'string' ||
      intent.modelId !== execution.adapter_id ||
      execution.definition_version !== '1'
    )
      return null;
    return parent;
  } catch {
    return null;
  }
}
function owned(
  db: SqliteOperations,
  input: { expectedStoreId: string; owner: import('../types').OwnerRef; executionId: string },
  live = true,
) {
  db.identity(input.expectedStoreId);
  const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
  if (
    !execution ||
    execution.origin_store_id !== input.expectedStoreId ||
    String(execution.owner_generation) !== input.owner.generation
  )
    throw new AgentError('internal_model_unverifiable');
  db.owner(input.owner, String(execution.session_id));
  const parent = internalModelSourceTarget(db, execution);
  if (!parent) throw new AgentError('internal_model_unverifiable');
  if (live) {
    db.ancestors(input.owner, input.executionId);
    if (parent.state !== 'running' && parent.state !== 'dispatching')
      throw new AgentError('internal_model_parent_inactive');
  }
  return { execution, parent };
}
export function ensureInternalModel(
  db: SqliteOperations,
  input: Parameters<Store['ensureInternalModel']>[0],
) {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const parent = db.row('SELECT * FROM execution WHERE id=?', input.parentExecutionId);
    if (
      parent?.adapter_id !== 'builtin.session-title/generate' ||
      parent.definition_version !== '1' ||
      !parent.dispatched ||
      !['running', 'dispatching'].includes(String(parent.state)) ||
      parent.cancel_requested ||
      parent.origin_store_id !== input.expectedStoreId ||
      String(parent.owner_generation) !== input.owner.generation
    )
      throw new AgentError('internal_model_parent_inactive');
    db.owner(input.owner, String(parent.session_id));
    assertCurrentChildPurpose(db, String(parent.session_id));
    db.ancestors(input.owner, input.parentExecutionId);
    assertNoExecutionGroupFence(db, String(parent.session_id), String(parent.id));
    const origin = db.row('SELECT * FROM command WHERE id=?', parent.origin_command_id!)!;
    const request = object(input.request);
    if (
      typeof request.requestId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(request.requestId) ||
      typeof request.modelId !== 'string' ||
      !request.modelId ||
      canonicalJson(request.tools ?? []) !== '[]' ||
      (!request.body && !Array.isArray(request.messages))
    )
      throw new AgentError('internal_model_request_invalid');
    verifyModelBody(db, input.request, parent);
    if (input.modelMetadata !== undefined) verifyModelBody(db, input.modelMetadata, parent);
    const key = `title/${parent.id}`,
      prior = db.row(
        "SELECT * FROM command WHERE kind='session.title' AND session_id=? AND operation_key=?",
        parent.session_id!,
        key,
      );
    const envelope: Json = {
      kind: 'session.title',
      parentExecutionId: String(parent.id),
      request: input.request,
    };
    if (prior) {
      if (prior.request_json !== canonicalJson(envelope))
        throw new AgentError('internal_model_binding_changed');
      const receipt = object(JSON.parse(String(prior.receipt_json)));
      const execution = db.row('SELECT * FROM execution WHERE id=?', String(receipt.executionId));
      if (!execution || !internalModelSourceTarget(db, execution))
        throw new AgentError('internal_model_unverifiable');
      return { execution: db.execution(execution), created: false };
    }
    const commandId = randomUUID(),
      id = request.requestId as string;
    if (db.row('SELECT id FROM execution WHERE id=?', id))
      throw new AgentError('internal_model_binding_changed');
    db.allocateSessionSequence(String(parent.session_id));
    const seq = db.row('SELECT next_seq FROM session WHERE id=?', parent.session_id!)!.next_seq!;
    db.run(
      "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,'session.title',?,?,?,'applied',?,?,?,?,?,'execution',?,?)",
      commandId,
      parent.session_id!,
      seq,
      origin.subject_id!,
      hash(envelope),
      canonicalJson(envelope),
      canonicalJson({ commandId, executionId: id, preparedInputDigest: hash(input.request) }),
      parent.origin_store_id!,
      parent.root_work_command_id!,
      parent.root_work_seq!,
      '__internal_model__',
      parent.id!,
      key,
    );
    db.run(
      "INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation,parent_execution_id,cancel_with_parent,model_snapshot_json,requirements_json) VALUES(?,?,NULL,'model',?,?,?,?,?,?,?,1,?,'1','planned',?,?,?,?,1,?,'[]')",
      id,
      parent.session_id!,
      commandId,
      parent.origin_store_id!,
      parent.root_work_command_id!,
      parent.root_work_seq!,
      parent.root_session_id!,
      key,
      id,
      request.modelId,
      canonicalJson(input.request),
      parent.decision_source_json!,
      parent.owner_generation!,
      parent.id!,
      input.modelMetadata === undefined ? null : canonicalJson(input.modelMetadata),
    );
    db.event(String(parent.session_id), id, 'execution.planned');
    return {
      execution: db.execution(db.row('SELECT * FROM execution WHERE id=?', id)!),
      created: true,
    };
  });
}
export function dispatchInternalModel(
  db: SqliteOperations,
  input: Parameters<Store['dispatchInternalModel']>[0],
) {
  return db.tx(() => {
    const { execution } = owned(db, input);
    assertNoExecutionGroupFence(db, String(execution.session_id), String(execution.id));
    if (execution.state !== 'planned' || execution.dispatched)
      throw new AgentError('execution_not_dispatchable');
    const authorization = input.authorization;
    if (
      authorization?.allowed !== true ||
      typeof authorization.revision !== 'string' ||
      !authorization.revision ||
      authorization.definitionVersion !== execution.definition_version ||
      authorization.inputDigest !== hash(JSON.parse(String(execution.intent_json))) ||
      authorization.checkExecutionId !== undefined ||
      authorization.reviewExecutionId !== undefined ||
      authorization.interactionId !== undefined ||
      authorization.decisionRevision !== undefined ||
      authorization.grant !== undefined
    )
      throw new AgentError('permission_denied');
    assertHumanWorkDispatch(db, execution);
    verifyHostControlReads(db, execution, input.expectedStoreId, authorization.controlReads);
    db.run(
      "UPDATE execution SET state='dispatching',dispatched=1,dispatch_authorization_json=? WHERE id=?",
      canonicalJson(authorization as unknown as Json),
      execution.id!,
    );
    db.event(String(execution.session_id), String(execution.id), 'execution.dispatching');
    return db.execution(db.row('SELECT * FROM execution WHERE id=?', execution.id!)!);
  });
}
export function persistInternalModelPartial(
  db: SqliteOperations,
  input: Parameters<Store['persistInternalModelPartial']>[0],
) {
  return db.tx(() => {
    const { execution } = owned(db, input);
    if (!execution.dispatched || !['dispatching', 'running'].includes(String(execution.state)))
      throw new AgentError('execution_not_active');
    const prior = execution.result_json ? object(JSON.parse(String(execution.result_json))) : null;
    if (input.modelOutput) {
      const next = verifyModelOutput(db, input.modelOutput, execution);
      if (next.complete) throw new AgentError('model_output_invalid');
      const old = prior?.modelOutput ? verifyModelOutput(db, prior.modelOutput, execution) : null;
      if (
        (old &&
          (BigInt(next.seq) < BigInt(old.seq) ||
            BigInt(next.seq) > BigInt(old.seq) + 1n ||
            BigInt(next.contentBytes) < BigInt(old.contentBytes) ||
            BigInt(next.reasoningBytes) < BigInt(old.reasoningBytes) ||
            next.toolCallCount < old.toolCallCount ||
            (BigInt(next.seq) === BigInt(old.seq) &&
              canonicalJson(next as unknown as Json) !== canonicalJson(old as unknown as Json)))) ||
        (!old && next.seq !== '1')
      )
        throw new AgentError('model_output_conflict');
    }
    const result: Json = {
      content: input.content,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.firstOutput ? { firstOutput: input.firstOutput } : {}),
      ...(input.modelOutput ? { modelOutput: input.modelOutput as unknown as Json } : {}),
    };
    db.run(
      "UPDATE execution SET state='running',result_json=? WHERE id=?",
      canonicalJson(result),
      execution.id!,
    );
    db.event(String(execution.session_id), String(execution.id), 'session.title.partial');
  });
}
export function internalModelCompletedResult(db: SqliteOperations, execution: Row): boolean {
  try {
    if (
      execution.state !== 'succeeded' ||
      !execution.dispatched ||
      !internalModelSourceTarget(db, execution)
    )
      return false;
    const command = db.row(
        'SELECT receipt_json FROM command WHERE id=?',
        execution.origin_command_id!,
      )!,
      result = object(JSON.parse(String(execution.result_json)));
    if (
      object(JSON.parse(String(command.receipt_json))).completedResultDigest !== hash(result) ||
      result.finishReason !== 'stop' ||
      canonicalJson(result.toolCalls ?? []) !== '[]'
    )
      return false;
    const body = bodyReference(object(JSON.parse(String(execution.intent_json))).body);
    if (body && result.modelInputBodyHash !== body.reference.hash) return false;
    if (result.modelOutput) {
      const descriptor = verifyModelOutput(db, result.modelOutput, execution);
      return descriptor.complete && descriptor.toolCallCount === 0;
    }
    return typeof result.content === 'string';
  } catch {
    return false;
  }
}
export function finishInternalModel(
  db: SqliteOperations,
  input: Parameters<Store['finishInternalModel']>[0],
) {
  return db.tx(() => {
    const { execution } = owned(db, input, false);
    if (Object.hasOwn(input, 'message')) throw new AgentError('internal_model_request_invalid');
    if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(execution.state))) {
      if (execution.state !== input.status || execution.result_json !== canonicalJson(input.result))
        throw new AgentError('terminal_conflict');
      return db.execution(execution);
    }
    const result = object(input.result);
    if (input.status === 'succeeded') {
      owned(db, input);
      if (
        !execution.dispatched ||
        result.finishReason !== 'stop' ||
        canonicalJson(result.toolCalls ?? []) !== '[]'
      )
        throw new AgentError('internal_model_output_invalid');
      const body = bodyReference(object(JSON.parse(String(execution.intent_json))).body);
      if (body && result.modelInputBodyHash !== body.reference.hash)
        throw new AgentError('model_body_receipt_invalid');
      if (result.modelOutput) {
        const descriptor = verifyModelOutput(db, result.modelOutput, execution);
        const partial = execution.result_json
          ? object(JSON.parse(String(execution.result_json))).modelOutput
          : null;
        if (
          !descriptor.complete ||
          descriptor.toolCallCount !== 0 ||
          !partial ||
          canonicalJson({ ...descriptor, complete: false } as unknown as Json) !==
            canonicalJson(partial)
        )
          throw new AgentError('model_output_conflict');
      } else if (typeof result.content !== 'string')
        throw new AgentError('internal_model_output_invalid');
      const command = db.row(
          'SELECT receipt_json FROM command WHERE id=?',
          execution.origin_command_id!,
        )!,
        receipt = object(JSON.parse(String(command.receipt_json)));
      db.run(
        'UPDATE command SET receipt_json=? WHERE id=?',
        canonicalJson({ ...receipt, completedResultDigest: hash(input.result) }),
        execution.origin_command_id!,
      );
    } else if (result.modelOutput && verifyModelOutput(db, result.modelOutput, execution).complete)
      throw new AgentError('model_output_invalid');
    db.run(
      'UPDATE execution SET state=?,result_json=?,result_revision=result_revision+1 WHERE id=?',
      input.status,
      canonicalJson(input.result),
      execution.id!,
    );
    db.event(String(execution.session_id), String(execution.id), 'execution.finished');
    db.run(
      'UPDATE execution SET completed_cursor=(SELECT last_change_cursor FROM storage_meta WHERE singleton=1) WHERE id=?',
      execution.id!,
    );
    return db.execution(db.row('SELECT * FROM execution WHERE id=?', execution.id!)!);
  });
}
