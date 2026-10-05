import { canonicalJson } from '../../json';
import {
  assertModelOutputScope,
  type ModelOutputReference,
  modelOutputReference,
} from '../../model-output';
import type { Store } from '../port';
import type { StoredModelOutput, ToolCall } from '../types';
import { AgentError, type Json } from '../types';
import { identity, sessionScope } from './model-input-operations';
import type { SqliteOperations } from './operations';
/** Finite metadata only in the transaction; immutable segment bytes are verified by Core. */
export function verifyModelOutput(
  db: SqliteOperations,
  value: unknown,
  execution: Record<string, string | number | bigint | null>,
): ModelOutputReference {
  const output = modelOutputReference(value);
  if (!output || execution.kind !== 'model') throw new AgentError('model_output_invalid');
  const command = db.row('SELECT subject_id FROM command WHERE id=?', execution.origin_command_id!);
  if (!command) throw new AgentError('model_output_scope_denied');
  assertModelOutputScope(output.head, {
    storeId: String(execution.origin_store_id),
    sessionId: String(execution.session_id),
    subjectId: String(command.subject_id),
    executionId: String(execution.id),
  });
  const ref = db.row(
    'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=?',
    output.head.id,
  );
  if (
    !ref ||
    ref.origin_store_id !== output.head.storeId ||
    ref.session_id !== output.head.sessionId ||
    ref.subject_id !== output.head.subjectId ||
    ref.owner_kind !== 'execution' ||
    ref.owner_id !== execution.id ||
    ref.blob_hash !== output.head.hash ||
    String(ref.size) !== output.head.size ||
    ref.media_type !== output.head.mediaType
  )
    throw new AgentError('model_output_invalid');
  return output;
}
export function modelOutputOf(value: Json): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value.modelOutput
    : undefined;
}

export function getModelOutputSnapshot(
  db: SqliteOperations,
  input: Parameters<Store['getModelOutputSnapshot']>[0],
): StoredModelOutput {
  db.db.run('BEGIN');
  try {
    if (
      Object.keys(input).some(
        (key) => !['expectedStoreId', 'sessionId', 'subjectId', 'executionId'].includes(key),
      )
    )
      throw new AgentError('model_output_scope_denied');
    const session = sessionScope(db, input);
    const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
    if (!execution) throw new AgentError('execution_not_found');
    const bound = identity(db, input, session, execution);
    const result = (
      execution.result_json ? JSON.parse(String(execution.result_json)) : null
    ) as Record<string, Json> | null;
    const partial = db.row(
      "SELECT source_json FROM message WHERE id=? AND session_id=? AND run_id=? AND status='incomplete' AND role='assistant'",
      `partial_${input.executionId}`,
      input.sessionId,
      execution.run_id!,
    );
    const prefix = (partial ? JSON.parse(String(partial.source_json)) : null) as Record<
      string,
      Json
    > | null;
    let value = result;
    const complete = execution.state === 'succeeded';
    if (!complete && prefix) value = prefix;
    const descriptor = value?.modelOutput;
    const output = descriptor === undefined ? null : verifyModelOutput(db, descriptor, execution);
    if (output && output.complete !== complete) throw new AgentError('model_output_invalid');
    if (complete) {
      const messages = db.rows(
        "SELECT source_json FROM message WHERE session_id=? AND run_id=? AND role='assistant' AND status='complete' AND json_array_length(json_extract(source_json,'$.sourceIds'))=1 AND json_extract(source_json,'$.sourceIds[0]')=?",
        input.sessionId,
        execution.run_id!,
        input.executionId,
      );
      if (messages.length !== 1) throw new AgentError('model_output_invalid');
      const message = JSON.parse(String(messages[0]!.source_json)) as Record<string, Json>;
      if (
        canonicalJson(message.modelOutput ?? null) !== canonicalJson(result?.modelOutput ?? null) ||
        message.content !== result?.content ||
        canonicalJson(message.toolCalls ?? []) !== canonicalJson(result?.toolCalls ?? [])
      )
        throw new AgentError('model_output_invalid');
    }
    const snapshot: StoredModelOutput = {
      storeId: input.expectedStoreId,
      originStoreId: String(execution.origin_store_id),
      identity: bound,
      subjectId: input.subjectId,
      snapshotCursor: db.metadata().lastChangeCursor,
      output,
      content: typeof value?.content === 'string' ? value.content : '',
      reasoning: typeof value?.reasoning === 'string' ? value.reasoning : '',
      toolCalls: complete ? ((value?.toolCalls ?? []) as unknown as ToolCall[]) : [],
      complete,
    };
    db.db.run('COMMIT');
    return snapshot;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
