import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import type { RecoveryToolHistory } from '../recovery-history';
import { AgentError, type Json, type ToolCall } from '../types';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined) => JSON.parse(String(value)) as Record<string, Json>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function unavailable(): never {
  throw new AgentError('recovery_tool_history_unverifiable');
}

export function recoveryToolHistory(db: SqliteOperations, tool: Row): RecoveryToolHistory | null {
  if (
    tool.kind !== 'tool' ||
    tool.run_id === null ||
    tool.state !== 'planned' ||
    tool.dispatched !== 0n ||
    tool.origin_store_id !== db.metadata().storeId
  )
    return null;
  const source = parse(tool.decision_source_json);
  if (source.kind !== 'model_decision') return null;
  if (typeof source.modelExecutionId !== 'string') return unavailable();
  const model = db.row('SELECT * FROM execution WHERE id=?', source.modelExecutionId);
  const run = db.row('SELECT * FROM run WHERE id=?', tool.run_id!);
  if (
    !model ||
    !run ||
    model.kind !== 'model' ||
    model.state !== 'succeeded' ||
    model.session_id !== tool.session_id ||
    model.run_id !== tool.run_id ||
    model.origin_store_id !== tool.origin_store_id ||
    model.origin_command_id !== tool.origin_command_id ||
    model.root_session_id !== tool.root_session_id ||
    model.root_work_command_id !== tool.root_work_command_id ||
    model.root_work_seq !== tool.root_work_seq ||
    run.session_id !== tool.session_id ||
    run.origin_store_id !== tool.origin_store_id ||
    run.origin_command_id !== tool.origin_command_id
  )
    return unavailable();
  const messages = db.rows(
    "SELECT * FROM message WHERE session_id=? AND run_id=? AND role='assistant' AND status='complete' AND json_array_length(json_extract(source_json,'$.sourceIds'))=1 AND json_extract(source_json,'$.sourceIds[0]')=? LIMIT 2",
    tool.session_id!,
    tool.run_id!,
    model.id!,
  );
  if (messages.length !== 1) return unavailable();
  const assistant = messages[0]!,
    value = parse(assistant.source_json),
    result = parse(model.result_json);
  if (
    value.content !== result.content ||
    canonicalJson(value.toolCalls ?? []) !== canonicalJson(result.toolCalls ?? []) ||
    canonicalJson(value.modelOutput ?? null) !== canonicalJson(result.modelOutput ?? null)
  )
    return unavailable();
  const inputDigest = hash(JSON.parse(String(tool.intent_json)) as Json);
  let output: RecoveryToolHistory['modelOutput'] = null;
  if (result.modelOutput !== undefined) {
    output = verifyModelOutput(db, result.modelOutput, model);
    if (!output.complete || output.toolCallCount < 1) return unavailable();
  } else {
    const calls = result.toolCalls as unknown as ToolCall[];
    if (!Array.isArray(calls)) return unavailable();
    const matches = calls.filter((call) => call.id === tool.call_id);
    if (matches.length !== 1 || matches[0]!.name !== tool.adapter_id) return unavailable();
    try {
      if (hash(JSON.parse(matches[0]!.arguments) as Json) !== inputDigest) return unavailable();
    } catch {
      return unavailable();
    }
  }
  if (
    db.row(
      "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='tool' AND EXISTS(SELECT 1 FROM json_each(json_extract(source_json,'$.sourceIds')) ids WHERE ids.value=?) LIMIT 1",
      tool.session_id!,
      tool.run_id!,
      tool.id!,
    )
  )
    return unavailable();
  return {
    executionId: String(tool.id),
    sessionId: String(tool.session_id),
    runId: String(tool.run_id),
    modelExecutionId: String(model.id),
    callId: String(tool.call_id),
    definitionId: String(tool.adapter_id),
    inputDigest,
    modelOutput: output,
    bindingDigest: hash({
      tool: {
        id: String(tool.id),
        state: String(tool.state),
        resultRevision: String(tool.result_revision),
        ownerGeneration: String(tool.owner_generation),
        source: JSON.parse(String(tool.decision_source_json)) as Json,
        inputDigest,
        callId: String(tool.call_id),
        definitionId: String(tool.adapter_id),
        definitionVersion: String(tool.definition_version),
        originStoreId: String(tool.origin_store_id),
        originCommandId: String(tool.origin_command_id),
        rootSessionId: String(tool.root_session_id),
        rootWorkCommandId: String(tool.root_work_command_id),
        rootWorkSeq: String(tool.root_work_seq),
      },
      model: {
        id: String(model.id),
        resultRevision: String(model.result_revision),
        ownerGeneration: String(model.owner_generation),
        originStoreId: String(model.origin_store_id),
        originCommandId: String(model.origin_command_id),
        rootSessionId: String(model.root_session_id),
        rootWorkCommandId: String(model.root_work_command_id),
        rootWorkSeq: String(model.root_work_seq),
        result: JSON.parse(String(model.result_json)) as Json,
      },
      run: {
        id: String(run.id),
        originStoreId: String(run.origin_store_id),
        originCommandId: String(run.origin_command_id),
        state: String(run.status),
        active: String(run.is_active),
      },
      assistant: { id: String(assistant.id), seq: String(assistant.seq), source: value },
      sessionId: String(tool.session_id),
      runId: String(tool.run_id),
    }),
  };
}

export function readRecoveryToolHistory(
  db: SqliteOperations,
  input: Parameters<Store['readRecoveryToolHistory']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const root = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!root || root.delete_requested) throw new AgentError('session_not_found');
    if (root.parent_id !== null) throw new AgentError('group_root_required');
    if (
      db.row(
        "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
        input.sessionId,
      )?.subject_id !== input.subjectId
    )
      throw new AgentError('permission_denied');
    if (String(root.owner_generation) !== input.expectedOwnerGeneration)
      throw new AgentError('owner_changed');
    const tools = db.rows(
      "SELECT * FROM execution WHERE root_session_id=? AND kind='tool' AND run_id IS NOT NULL AND state='planned' AND dispatched=0 AND origin_store_id=? ORDER BY id LIMIT 4097",
      input.sessionId,
      input.expectedStoreId,
    );
    if (tools.length > 4096) throw new AgentError('recovery_too_large');
    const result = tools
      .map((tool) => recoveryToolHistory(db, tool))
      .filter((value): value is RecoveryToolHistory => value !== null);
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
