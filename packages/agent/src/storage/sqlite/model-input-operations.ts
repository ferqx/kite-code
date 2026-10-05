import type { Store } from '../port';
import {
  AgentError,
  type Json,
  type ModelInputIdentity,
  type ModelInputPage,
  type StoredModelInput,
} from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
type Scope = { expectedStoreId: string; sessionId: string; subjectId: string };
export function sessionScope(db: SqliteOperations, input: Scope): Row {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session) throw new AgentError('session_not_found');
  const root = db.row('SELECT * FROM session WHERE id=? AND parent_id IS NULL', session.root_id!);
  const creator =
    root &&
    db.row(
      "SELECT subject_id,origin_store_id FROM command WHERE session_id=? AND kind='session.create'",
      root.id!,
    );
  if (!root || !creator || creator.subject_id !== input.subjectId)
    throw new AgentError('model_input_scope_denied');
  return session;
}
export function identity(
  db: SqliteOperations,
  input: Scope,
  session: Row,
  execution: Row,
): ModelInputIdentity {
  const originStoreId = execution.origin_store_id;
  if (typeof originStoreId !== 'string' || !originStoreId)
    throw new AgentError('model_input_scope_denied');
  if (execution.session_id !== session.id) throw new AgentError('model_input_scope_denied');
  if (execution.kind !== 'model' || execution.run_id === null)
    throw new AgentError('model_input_unavailable');
  const run = db.row(
    'SELECT id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq FROM run WHERE id=? AND session_id=?',
    execution.run_id!,
    session.id!,
  );
  const command = db.row(
    'SELECT id,session_id,subject_id,origin_store_id,root_work_command_id,root_work_seq FROM command WHERE id=? AND session_id=?',
    execution.origin_command_id!,
    session.id!,
  );
  const rootWork = db.row(
    'SELECT id,seq,session_id,subject_id,origin_store_id FROM command WHERE id=? AND session_id=?',
    execution.root_work_command_id!,
    session.root_id!,
  );
  if (
    !run ||
    !command ||
    !rootWork ||
    !Number.isSafeInteger(Number(execution.attempt)) ||
    Number(execution.attempt) < 1 ||
    !/^[1-9][0-9]*$/.test(String(execution.root_work_seq)) ||
    BigInt(execution.root_work_seq!) > 9223372036854775807n ||
    run.origin_store_id !== originStoreId ||
    command.origin_store_id !== originStoreId ||
    rootWork.origin_store_id !== originStoreId ||
    command.subject_id !== input.subjectId ||
    rootWork.subject_id !== input.subjectId ||
    run.origin_command_id !== execution.origin_command_id ||
    execution.root_session_id !== session.root_id ||
    run.root_work_command_id !== execution.root_work_command_id ||
    command.root_work_command_id !== execution.root_work_command_id ||
    String(run.root_work_seq) !== String(execution.root_work_seq) ||
    String(command.root_work_seq) !== String(execution.root_work_seq) ||
    String(rootWork.seq) !== String(execution.root_work_seq)
  )
    throw new AgentError('model_input_scope_denied');
  if (session.parent_id !== null) {
    const carrier = db.childCarrier(command, String(run.id));
    const origin =
      carrier &&
      db.row(
        'SELECT subject_id,origin_store_id FROM command WHERE id=?',
        carrier.origin_command_id!,
      );
    if (
      !carrier ||
      !origin ||
      carrier.child_session_id !== session.id ||
      carrier.session_id !== session.parent_id ||
      carrier.root_session_id !== session.root_id ||
      carrier.origin_store_id !== originStoreId ||
      origin.origin_store_id !== originStoreId ||
      origin.subject_id !== input.subjectId ||
      carrier.root_work_command_id !== execution.root_work_command_id ||
      String(carrier.root_work_seq) !== String(execution.root_work_seq)
    )
      throw new AgentError('model_input_scope_denied');
  }
  return {
    executionId: String(execution.id),
    sessionId: String(session.id),
    rootSessionId: String(session.root_id),
    runId: String(run.id),
    originCommandId: String(command.id),
    rootWorkCommandId: String(execution.root_work_command_id),
    rootWorkSeq: String(execution.root_work_seq),
    attempt: Number(execution.attempt),
    status: execution.state as ModelInputIdentity['status'],
    confirmation: execution.state === 'succeeded' ? 'succeeded' : 'unconfirmed',
    modelId: String(execution.adapter_id),
  };
}
function sequence(value: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_model_input_cursor');
  return BigInt(value);
}
export function getModelInputSnapshot(
  db: SqliteOperations,
  input: Parameters<Store['getModelInputSnapshot']>[0],
): StoredModelInput {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    if (
      Object.keys(input).some(
        (key) => !['expectedStoreId', 'sessionId', 'executionId', 'subjectId'].includes(key),
      )
    )
      throw new AgentError('model_input_scope_denied');
    const session = sessionScope(db, input);
    const execution = db.row(
      "SELECT id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,attempt,state,adapter_id,intent_json,model_snapshot_json,dispatch_authorization_json,json_extract(result_json,'$.modelInputBodyHash') AS receipt_hash FROM execution WHERE id=?",
      input.executionId,
    );
    if (!execution) throw new AgentError('execution_not_found');
    const bound = identity(db, input, session, execution);
    const snapshot = {
      storeId: input.expectedStoreId,
      originStoreId: String(execution.origin_store_id),
      identity: bound,
      input: JSON.parse(String(execution.intent_json)) as Json,
      receiptInputHash: typeof execution.receipt_hash === 'string' ? execution.receipt_hash : null,
      metadata:
        execution.model_snapshot_json === null
          ? null
          : (JSON.parse(String(execution.model_snapshot_json)) as Json),
      dispatchAuthorization:
        execution.dispatch_authorization_json === null
          ? null
          : (JSON.parse(String(execution.dispatch_authorization_json)) as Json),
      subjectId: input.subjectId,
      snapshotCursor: db.metadata().lastChangeCursor,
    };
    db.db.run('COMMIT');
    return snapshot;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function listModelInputs(
  db: SqliteOperations,
  input: Parameters<Store['listModelInputs']>[0],
): ModelInputPage {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    if (
      Object.keys(input).some(
        (key) =>
          !['expectedStoreId', 'sessionId', 'subjectId', 'afterSeq', 'upperSeq', 'limit'].includes(
            key,
          ),
      )
    )
      throw new AgentError('invalid_model_input_cursor');
    const session = sessionScope(db, input);
    const after = sequence(input.afterSeq ?? '0');
    const highWater = String(
      db.row(
        "SELECT COALESCE(MAX(rowid),0) AS seq FROM execution WHERE session_id=? AND kind='model'",
        session.id!,
      )!.seq,
    );
    const upper = sequence(input.upperSeq ?? highWater);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || upper < after)
      throw new AgentError('invalid_model_input_cursor');
    if (upper > sequence(highWater) || after > sequence(highWater))
      throw new AgentError('cursor_ahead');
    const rows = db.rows(
      "SELECT rowid AS model_seq,id,session_id,run_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,kind,attempt,state,adapter_id FROM execution WHERE session_id=? AND kind='model' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",
      session.id!,
      after,
      upper,
      limit + 1,
    );
    const items = rows
      .slice(0, limit)
      .map((row) => ({ ...identity(db, input, session, row), seq: String(row.model_seq) }));
    const page = {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      rootSessionId: String(session.root_id),
      items,
      highWaterSeq: highWater,
      upperSeq: String(upper),
      nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
      snapshotCursor: db.metadata().lastChangeCursor,
    };
    db.db.run('COMMIT');
    return page;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
