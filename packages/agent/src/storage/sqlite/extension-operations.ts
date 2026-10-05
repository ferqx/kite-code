import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import {
  AgentError,
  type ExtensionRecord,
  type ExtensionRecordWrite,
  type Json,
  type OperationRef,
} from '../types';
import { ensureAgent } from './child-operations';
import { actualRoot, assertNoExecutionGroupFence, executionGuard } from './execution-group-safety';
import type { SqliteOperations } from './operations';

type Method =
  | 'getExtensionRecord'
  | 'listExtensionRecords'
  | 'writeExtensionRecord'
  | 'ensureOperation'
  | 'getOperation'
  | 'planAction'
  | 'applyExtensionAction'
  | 'stopActionPreparation';
const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];
function digest(value: Json): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function object(value: Json): { [key: string]: Json } {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new AgentError('invalid_operation');
  return value;
}
function scope(db: SqliteOperations, extensionId: string, sessionId: string): void {
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(extensionId) ||
    !db.row('SELECT id FROM session WHERE id=? AND delete_requested=0', sessionId)
  )
    throw new AgentError('invalid_extension_scope');
}
export function record(row: Record<string, string | number | bigint | null>): ExtensionRecord {
  return {
    forkProvenance: row.fork_provenance_json
      ? (JSON.parse(String(row.fork_provenance_json)) as Json)
      : null,
    extensionId: String(row.extension_id),
    sessionId: String(row.scope_id),
    key: String(row.key),
    revision: String(row.revision),
    contentType: String(row.content_type),
    contentVersion: Number(row.content_version),
    originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
    value: JSON.parse(String(row.json)) as Json,
  };
}
function ref(row: Record<string, string | number | bigint | null>): OperationRef {
  const receipt = row.receipt_json ? object(JSON.parse(String(row.receipt_json)) as Json) : {};
  return {
    commandId: String(row.id),
    sessionId: String(row.session_id),
    originStoreId: String(row.origin_store_id),
    extensionId: String(row.extension_id),
    key: String(row.operation_key),
    executionId: typeof receipt.executionId === 'string' ? receipt.executionId : null,
    ...(typeof receipt.childSessionId === 'string'
      ? { childSessionId: receipt.childSessionId }
      : {}),
  };
}
export function verifyNamespace(
  db: SqliteOperations,
  extensionId: string,
  command: Record<string, string | number | bigint | null>,
  executionId?: string,
): void {
  const request = object(JSON.parse(String(command.request_json)) as Json);
  if (request.extensionId === extensionId) return;
  const execution = executionId
    ? db.row(
        'SELECT * FROM execution WHERE id=? AND origin_command_id=? AND session_id=?',
        executionId,
        command.id!,
        command.session_id!,
      )
    : null;
  if (execution?.kind !== 'tool') throw new AgentError('extension_namespace_mismatch');
  const matches = (value: Json) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (
      value.id === execution.adapter_id &&
      value.version === execution.definition_version &&
      value.extensionId === extensionId
    );
  };
  const source = object(JSON.parse(String(execution.decision_source_json)) as Json);
  if (source.kind === 'model_decision' && typeof source.modelExecutionId === 'string') {
    const model = db.row(
      "SELECT * FROM execution WHERE id=? AND kind='model' AND state='succeeded' AND session_id=? AND origin_store_id=? AND root_work_command_id=? AND root_work_seq=?",
      source.modelExecutionId,
      execution.session_id!,
      execution.origin_store_id!,
      execution.root_work_command_id!,
      execution.root_work_seq!,
    );
    const decision = model ? object(JSON.parse(String(model.decision_source_json)) as Json) : {};
    const input = model ? object(JSON.parse(String(model.intent_json)) as Json) : {};
    let sameRun = model && execution.run_id === model.run_id;
    if (model && execution.run_id === null) {
      const visited = new Set([String(execution.id)]);
      let parentId = execution.parent_execution_id;
      for (let depth = 0; parentId && depth < 32; depth++) {
        if (visited.has(String(parentId))) break;
        visited.add(String(parentId));
        const parent = db.row(
          'SELECT * FROM execution WHERE id=? AND session_id=? AND origin_store_id=? AND root_work_command_id=? AND root_work_seq=?',
          parentId,
          execution.session_id!,
          execution.origin_store_id!,
          execution.root_work_command_id!,
          execution.root_work_seq!,
        );
        if (!parent) break;
        if (parent.run_id === model.run_id) {
          sameRun = parent.kind === 'tool';
          break;
        }
        if (parent.run_id !== null) break;
        parentId = parent.parent_execution_id;
      }
    }
    if (
      sameRun &&
      Array.isArray(decision.toolBindings) &&
      decision.toolBindings.some(matches) &&
      Array.isArray(input.tools) &&
      input.tools.some(
        (tool) =>
          tool &&
          typeof tool === 'object' &&
          !Array.isArray(tool) &&
          tool.id === execution.adapter_id &&
          tool.definitionVersion === execution.definition_version,
      )
    )
      return;
  }
  if (execution.run_id === null) throw new AgentError('extension_namespace_mismatch');
  const run = db.row(
    'SELECT config_json FROM run WHERE id=? AND session_id=?',
    execution.run_id!,
    command.session_id!,
  );
  const configuration = run ? object(JSON.parse(String(run.config_json)) as Json) : {};
  if (!Array.isArray(configuration.tools) || !configuration.tools.some(matches))
    throw new AgentError('extension_namespace_mismatch');
}
function writeRecord(
  db: SqliteOperations,
  extensionId: string,
  sessionId: string,
  originCommandId: string,
  write: ExtensionRecordWrite,
  originExecutionId?: string,
): ExtensionRecord {
  scope(db, extensionId, sessionId);
  if (
    !write.key ||
    write.key.length > 256 ||
    !Number.isSafeInteger(write.contentVersion) ||
    write.contentVersion < 1
  )
    throw new AgentError('invalid_extension_record');
  const command = db.row(
    'SELECT * FROM command WHERE id=? AND session_id=?',
    originCommandId,
    sessionId,
  );
  if (!command) throw new AgentError('command_not_found');
  verifyNamespace(db, extensionId, command, originExecutionId);
  const prior = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    extensionId,
    sessionId,
    write.key,
  );
  if ((prior ? String(prior.revision) : null) !== write.expectedRevision)
    throw new AgentError('record_revision_conflict');
  const origin = prior?.origin_store_id ?? (write.executable ? command.origin_store_id : null);
  if (prior?.origin_store_id === null && write.executable)
    throw new AgentError('record_execution_origin_immutable');
  const revision = prior ? BigInt(prior.revision!) + 1n : 1n;
  if (revision > 9223372036854775807n) throw new AgentError('sequence_exhausted');
  db.run(
    "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,?,?,?,?,?) ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET revision=excluded.revision,content_type=excluded.content_type,content_version=excluded.content_version,json=excluded.json",
    extensionId,
    sessionId,
    write.key,
    revision,
    write.contentType,
    write.contentVersion,
    origin,
    canonicalJson(write.value),
  );
  db.event(sessionId, `${extensionId}/${write.key}`, 'extension.record_updated');
  return record(
    db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      extensionId,
      sessionId,
      write.key,
    )!,
  );
}
export function callExtension(db: SqliteOperations, method: Method, args: unknown[]): unknown {
  switch (method) {
    case 'getExtensionRecord': {
      const input = args[0] as Parameters<Store['getExtensionRecord']>[0];
      scope(db, input.extensionId, input.sessionId);
      const row = db.row(
        "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
        input.extensionId,
        input.sessionId,
        input.key,
      );
      return row ? record(row) : null;
    }
    case 'listExtensionRecords': {
      const input = args[0] as Parameters<Store['listExtensionRecords']>[0];
      scope(db, input.extensionId, input.sessionId);
      const filter = input.contentType ? ' AND content_type=?' : '';
      return db
        .rows(
          `SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>?${filter} ORDER BY key LIMIT ?`,
          input.extensionId,
          input.sessionId,
          input.afterKey ?? '',
          ...(input.contentType ? [input.contentType] : []),
          Math.max(1, Math.min(200, input.limit ?? 100)),
        )
        .map(record);
    }
    case 'writeExtensionRecord': {
      const input = args[0] as Parameters<Store['writeExtensionRecord']>[0];
      return db.tx(() => {
        db.identity(input.expectedStoreId);
        db.owner(input.owner, input.sessionId);
        const origin = db.active(input.owner, input.originCommandId);
        if (origin.session_id !== input.sessionId) throw new AgentError('invalid_extension_scope');
        if (input.originExecutionId) {
          db.ancestors(input.owner, input.originExecutionId);
          const source = db.row('SELECT state FROM execution WHERE id=?', input.originExecutionId);
          if (!source || !['dispatching', 'running'].includes(String(source.state)))
            throw new AgentError('invalid_operation_parent');
        }
        return writeRecord(
          db,
          input.extensionId,
          input.sessionId,
          input.originCommandId,
          input.write,
          input.originExecutionId,
        );
      });
    }
    case 'getOperation': {
      const input = args[0] as Parameters<Store['getOperation']>[0];
      scope(db, input.extensionId, input.sessionId);
      const row = db.row(
        "SELECT * FROM command WHERE origin_store_id=? AND extension_id=? AND scope_kind='session' AND scope_id=? AND operation_key=? AND subject_id=?",
        input.originStoreId,
        input.extensionId,
        input.sessionId,
        input.key,
        input.subjectId,
      );
      return row ? ref(row) : null;
    }
    case 'ensureOperation': {
      const input = args[0] as Parameters<Store['ensureOperation']>[0];
      if (input.request.kind === 'agent') return ensureAgent(db, input);
      return db.tx(() => {
        db.identity(input.expectedStoreId);
        scope(db, input.extensionId, input.sessionId);
        db.owner(input.owner, input.sessionId);
        if (input.request.kind === 'agent') throw new AgentError('unsupported_operation');
        if (!input.operationKey || input.operationKey.length > 256)
          throw new AgentError('invalid_extension_scope');
        const originCommand = db.active(input.owner, input.originCommandId);
        if (originCommand.session_id !== input.sessionId)
          throw new AgentError('invalid_extension_scope');
        const parent = db.row(
          'SELECT * FROM execution WHERE id=? AND session_id=?',
          input.parentExecutionId,
          input.sessionId,
        );
        if (
          !parent ||
          parent.origin_command_id !== input.originCommandId ||
          !['job', 'tool'].includes(String(parent.kind)) ||
          String(parent.owner_generation) !== input.owner.generation
        )
          throw new AgentError('invalid_operation_parent');
        verifyNamespace(db, input.extensionId, originCommand, input.parentExecutionId);
        let origin = String(originCommand.origin_store_id);
        if (input.planRecordKey) {
          const plan = db.row(
            "SELECT origin_store_id FROM extension_record WHERE fork_provenance_json IS NULL AND extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
            input.extensionId,
            input.sessionId,
            input.planRecordKey,
          );
          if (!plan || plan.origin_store_id === null)
            throw new AgentError('operation_unverifiable');
          origin = String(plan.origin_store_id);
        }
        const request: Json = {
          kind: `operation.${input.request.kind}`,
          definitionId: input.request.definitionId,
          definitionVersion: input.request.definitionVersion,
          input: input.request.input,
          parentExecutionId: input.parentExecutionId,
          extensionId: input.extensionId,
          operationKey: input.operationKey,
          cancellation: input.cancellation ?? 'attached',
        };
        if (
          !['tool', 'job'].includes(input.request.kind) ||
          !['attached', 'detached'].includes(input.cancellation ?? 'attached')
        )
          throw new AgentError('unsupported_operation');
        const requestDigest = digest(request);
        const prior = db.row(
          "SELECT * FROM command WHERE origin_store_id=? AND extension_id=? AND scope_kind='session' AND scope_id=? AND operation_key=?",
          origin,
          input.extensionId,
          input.sessionId,
          input.operationKey,
        );
        if (prior) {
          if (
            prior.subject_id !== originCommand.subject_id ||
            prior.request_digest !== requestDigest
          )
            throw new AgentError('operation_conflict');
          if (origin !== input.expectedStoreId) {
            const receipt = ref(prior);
            const execution = receipt.executionId
              ? db.row('SELECT state FROM execution WHERE id=?', receipt.executionId)
              : null;
            if (!execution || !terminal.includes(String(execution.state)))
              throw new AgentError('operation_unverifiable');
          }
          return ref(prior);
        }
        if (origin !== input.expectedStoreId) throw new AgentError('operation_unverifiable');
        assertNoExecutionGroupFence(db, input.sessionId);
        db.ancestors(input.owner, input.parentExecutionId);
        if (!['dispatching', 'running'].includes(String(parent.state)))
          throw new AgentError('invalid_operation_parent');
        const id = randomUUID();
        db.allocateSessionSequence(input.sessionId);
        const session = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!;
        db.run(
          "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,?,?,?,?,'accepted',?,?,?,?,?,'session',?,?)",
          id,
          input.sessionId,
          session.next_seq,
          `operation.${input.request.kind}`,
          originCommand.subject_id,
          requestDigest,
          canonicalJson(request),
          canonicalJson({ commandId: id }),
          origin,
          originCommand.root_work_command_id,
          originCommand.root_work_seq,
          input.extensionId,
          input.sessionId,
          input.operationKey,
        );
        if (input.request.kind === 'job') {
          const executionId = randomUUID();
          const target = db.row(
            'SELECT context_selection_id FROM session WHERE id=?',
            input.sessionId,
          )!;
          const inheritedRequirements =
            parent.run_id === null
              ? parent.requirements_json
              : db.row(
                  'SELECT requirements_json FROM run WHERE id=? AND session_id=?',
                  parent.run_id!,
                  input.sessionId,
                )?.requirements_json;
          db.run(
            "INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,parent_execution_id,cancel_with_parent,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation,delivery_target_session_id,context_selection_id,requirements_json) VALUES(?,?,NULL,'job',?,?,?,?,?,?,?, ?,?,1,?,?,'planned',?,?,?,?,?,?)",
            executionId,
            input.sessionId,
            id,
            origin,
            originCommand.root_work_command_id,
            originCommand.root_work_seq,
            input.parentExecutionId,
            input.cancellation === 'detached' ? 0 : 1,
            input.owner.sessionId,
            `operation-${id}`,
            id,
            input.request.definitionId,
            input.request.definitionVersion,
            canonicalJson(input.request.input),
            parent.decision_source_json,
            input.owner.generation,
            input.sessionId,
            target.context_selection_id,
            inheritedRequirements ?? '[]',
          );
          db.run(
            "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
            canonicalJson({ commandId: id, executionId }),
            id,
          );
          db.event(input.sessionId, executionId, 'execution.planned');
        }
        db.event(input.sessionId, id, 'operation.accepted');
        return ref(db.row('SELECT * FROM command WHERE id=?', id)!);
      });
    }
    case 'planAction': {
      const input = args[0] as Parameters<Store['planAction']>[0];
      return db.tx(() => {
        db.identity(input.expectedStoreId);
        const command = db.active(input.owner, input.commandId);
        assertNoExecutionGroupFence(db, String(command.session_id), input.executionId);
        const request = object(JSON.parse(String(command.request_json)) as Json);
        scope(db, input.extensionId, String(command.session_id));
        if (
          typeof request.actionId !== 'string' ||
          request.actionId.includes('/') ||
          request.actionId.length === 0
        )
          throw new AgentError('action_definition_conflict');
        if (
          request.kind !== 'extension.invoke' ||
          request.extensionId !== input.extensionId ||
          request.definitionVersion !== input.definitionVersion ||
          input.definitionId !== `${input.extensionId}/${request.actionId}`
        )
          throw new AgentError('action_definition_conflict');
        const source = object(input.decisionSource);
        if (
          source.kind !== 'action_decision' ||
          source.commandId !== input.commandId ||
          source.extensionId !== input.extensionId ||
          source.actionId !== request.actionId ||
          source.definitionVersion !== input.definitionVersion ||
          source.preparedDigest !== digest(input.input)
        )
          throw new AgentError('action_source_conflict');
        const attempt = input.attempt ?? 1;
        if (!Number.isSafeInteger(attempt) || attempt < 1)
          throw new AgentError('action_attempt_conflict');
        const prior = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
        if (prior) {
          if (
            prior.origin_command_id !== input.commandId ||
            prior.kind !== 'job' ||
            prior.run_id !== null ||
            prior.adapter_id !== input.definitionId ||
            prior.definition_version !== input.definitionVersion ||
            Number(prior.attempt) !== attempt ||
            prior.predecessor_execution_id !== (input.predecessorExecutionId ?? null) ||
            prior.intent_json !== canonicalJson(input.input) ||
            prior.decision_source_json !== canonicalJson(input.decisionSource)
          )
            throw new AgentError('action_intent_conflict');
          return db.execution(prior);
        }
        const receipt = object(JSON.parse(String(command.receipt_json)) as Json);
        if (input.predecessorExecutionId) {
          const predecessor = db.row(
            'SELECT * FROM execution WHERE id=?',
            input.predecessorExecutionId,
          );
          const result = predecessor?.result_json
            ? object(JSON.parse(String(predecessor.result_json)) as Json)
            : {};
          const details =
            result.details && typeof result.details === 'object' && !Array.isArray(result.details)
              ? result.details
              : {};
          if (
            command.status !== 'applied' ||
            receipt.executionId !== input.predecessorExecutionId ||
            predecessor?.origin_command_id !== input.commandId ||
            predecessor.kind !== 'job' ||
            predecessor.run_id !== null ||
            predecessor.state !== 'failed' ||
            predecessor.dispatched !== 0n ||
            details.code !== 'context_refresh_required' ||
            details.adapterAttempted !== false ||
            predecessor.adapter_id !== input.definitionId ||
            predecessor.definition_version !== input.definitionVersion ||
            attempt !== Number(predecessor.attempt) + 1
          )
            throw new AgentError('action_attempt_conflict');
        } else if (
          attempt !== 1 ||
          command.status !== 'accepted' ||
          db.row(
            "SELECT id FROM execution WHERE origin_command_id=? AND kind='job'",
            input.commandId,
          )
        ) {
          throw new AgentError('action_attempt_conflict');
        }
        db.run(
          "INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation,predecessor_execution_id) VALUES(?,?,NULL,'job',?,?,?,?,?,?,?,?,?,?,'planned',?,?,?,?)",
          input.executionId,
          command.session_id,
          input.commandId,
          command.origin_store_id,
          command.root_work_command_id,
          command.root_work_seq,
          actualRoot(db, String(command.session_id)).root.id,
          input.commandId,
          input.commandId,
          attempt,
          input.definitionId,
          input.definitionVersion,
          canonicalJson(input.input),
          canonicalJson(input.decisionSource),
          input.owner.generation,
          input.predecessorExecutionId ?? null,
        );
        executionGuard(db, db.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
        const carrier = db.childCarrier(command);
        if (carrier)
          db.run(
            'UPDATE execution SET parent_execution_id=? WHERE id=?',
            carrier.id,
            input.executionId,
          );
        db.run(
          "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
          canonicalJson({ executionId: input.executionId, preparingNextAttempt: false }),
          input.commandId,
        );
        db.event(String(command.session_id), input.executionId, 'action.planned');
        return db.execution(db.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
      });
    }
    case 'stopActionPreparation': {
      const input = args[0] as Parameters<Store['stopActionPreparation']>[0];
      return db.tx(() => {
        db.identity(input.expectedStoreId);
        db.owner(input.owner);
        const command = db.row('SELECT * FROM command WHERE id=?', input.commandId);
        if (command) db.owner(input.owner, String(command.session_id));
        const execution = db.row(
          'SELECT * FROM execution WHERE id=?',
          input.predecessorExecutionId,
        );
        const receipt = command?.receipt_json
          ? object(JSON.parse(String(command.receipt_json)) as Json)
          : {};
        if (
          !command ||
          execution?.origin_command_id !== input.commandId ||
          execution.kind !== 'job' ||
          execution.state !== 'failed' ||
          String(execution.owner_generation) !== input.owner.generation ||
          execution.dispatched !== 0n ||
          receipt.executionId !== input.predecessorExecutionId
        )
          throw new AgentError('action_attempt_conflict');
        if (
          receipt.preparationStopped === true &&
          receipt.reason === input.reason &&
          receipt.cancelled === input.cancelled
        )
          return db.command(command);
        if (receipt.preparingNextAttempt !== true) throw new AgentError('action_attempt_conflict');
        db.run(
          'UPDATE command SET status=?,cancelled=?,receipt_json=? WHERE id=?',
          input.cancelled ? 'applied' : 'needs_review',
          input.cancelled ? 1 : Number(command.cancelled),
          canonicalJson({
            ...receipt,
            preparingNextAttempt: false,
            preparationStopped: true,
            reason: input.reason,
            cancelled: input.cancelled,
            status: input.cancelled ? 'cancelled' : 'needs_review',
          }),
          input.commandId,
        );
        db.event(String(command.session_id), input.commandId, 'action.preparation_stopped');
        return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
      });
    }
    case 'applyExtensionAction': {
      const input = args[0] as Parameters<Store['applyExtensionAction']>[0];
      return db.tx(() => {
        db.identity(input.expectedStoreId);
        db.owner(input.owner);
        const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
        if (execution) db.owner(input.owner, String(execution.session_id));
        if (
          execution?.kind !== 'job' ||
          execution.run_id !== null ||
          String(execution.owner_generation) !== input.owner.generation
        )
          throw new AgentError('invalid_action_execution');
        if (execution.origin_store_id !== input.expectedStoreId)
          throw new AgentError('operation_unverifiable');
        const command = db.row(
          'SELECT * FROM command WHERE id=?',
          String(execution.origin_command_id),
        )!;
        const request = object(JSON.parse(String(command.request_json)) as Json);
        if (request.kind !== 'extension.invoke' || request.extensionId !== input.extensionId)
          throw new AgentError('extension_namespace_mismatch');
        if ((input.writes?.length ?? 0) > 32) throw new AgentError('too_many_record_writes');
        const preparingNextAttempt = input.preparingNextAttempt ?? false;
        if (preparingNextAttempt) {
          const result = object(input.result);
          const details =
            result.details && typeof result.details === 'object' && !Array.isArray(result.details)
              ? result.details
              : {};
          if (
            input.status !== 'failed' ||
            execution.dispatched !== 0n ||
            details.code !== 'context_refresh_required' ||
            details.adapterAttempted !== false
          )
            throw new AgentError('action_attempt_conflict');
        }
        const finalizationDigest = digest({
          status: input.status,
          preparingNextAttempt,
          result: input.result,
          writes: (input.writes ?? []) as unknown as Json,
          message: input.message ? (JSON.parse(JSON.stringify(input.message)) as Json) : null,
        });
        if (terminal.includes(String(execution.state))) {
          if (
            execution.state !== input.status ||
            execution.result_json !== canonicalJson(input.result) ||
            execution.finalization_digest !== finalizationDigest
          )
            throw new AgentError('terminal_conflict');
          return db.execution(execution);
        }
        const receipt = object(JSON.parse(String(command.receipt_json)) as Json);
        if (receipt.executionId !== input.executionId)
          throw new AgentError('action_attempt_conflict');
        if (execution.state === 'planned' && !['failed', 'cancelled'].includes(input.status))
          throw new AgentError('execution_not_dispatched');
        if (input.status === 'succeeded') {
          db.active(input.owner, String(execution.origin_command_id));
          db.ancestors(input.owner, input.executionId);
          if (
            db.row(
              "SELECT id FROM execution WHERE parent_execution_id=? AND kind='tool' AND state IN ('planned','dispatching','running','outcome_unknown')",
              input.executionId,
            )
          )
            throw new AgentError('execution_unsettled');
        }
        for (const write of input.writes ?? []) {
          db.active(input.owner, String(execution.origin_command_id));
          writeRecord(
            db,
            input.extensionId,
            String(execution.session_id),
            String(execution.origin_command_id),
            write,
          );
        }
        db.run(
          'UPDATE execution SET state=?,result_json=?,finalization_digest=?,result_revision=result_revision+1 WHERE id=?',
          input.status,
          canonicalJson(input.result),
          finalizationDigest,
          input.executionId,
        );
        db.run(
          'UPDATE command SET receipt_json=? WHERE id=?',
          canonicalJson({
            executionId: input.executionId,
            status: input.status,
            finalizationDigest,
            preparingNextAttempt,
          }),
          execution.origin_command_id,
        );
        if (input.message)
          db.appendMessage(
            String(execution.session_id),
            null,
            input.message as unknown as Json,
            input.message.role,
          );
        db.event(String(execution.session_id), input.executionId, 'action.finished');
        return db.execution(db.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
      });
    }
  }
}
