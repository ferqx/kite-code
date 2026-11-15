import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import type {
  RecoveryToolHistory,
  StoppedModelHistory,
  StoppedModelProof,
} from '../recovery-history';
import { AgentError, type Json, type ToolCall } from '../types';
import { userStopCommand } from './cancel-operations';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';
import { withReconciledFrontier } from './session-reconciliation';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined) => JSON.parse(String(value)) as Record<string, Json>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function unavailable(): never {
  throw new AgentError('recovery_tool_history_unverifiable');
}

function recoveryToolHistory(db: SqliteOperations, tool: Row): RecoveryToolHistory | null {
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

/** Route undispatched calls in a stopped model batch to that batch's identity proof. */
export function partitionRecoveryHistory(
  db: SqliteOperations,
  rootSessionId: string,
  executions: Row[],
) {
  const stoppedBatches = reconciledStoppedModelHistories(db, rootSessionId);
  const stoppedByRun = new Map(stoppedBatches.map((batch) => [batch.runId, batch]));
  const histories: RecoveryToolHistory[] = [];
  for (const tool of executions) {
    const batch = stoppedByRun.get(String(tool.run_id));
    if (
      batch &&
      tool.kind === 'tool' &&
      tool.state === 'planned' &&
      tool.dispatched === 0n &&
      tool.session_id === batch.sessionId
    ) {
      const source = parse(tool.decision_source_json);
      if (source.kind === 'model_decision' && source.modelExecutionId === batch.executionId)
        continue;
    }
    const history = recoveryToolHistory(db, tool);
    if (history) histories.push(history);
  }
  return { histories, stoppedBatches };
}

export function readUnstartedModelHistory(
  db: SqliteOperations,
  input: { sessionId: string; expectedStoreId: string },
) {
  const tools = db.rows(
    "SELECT * FROM execution WHERE root_session_id=? AND kind='tool' AND run_id IS NOT NULL AND state='planned' AND dispatched=0 AND origin_store_id=? ORDER BY id LIMIT 4097",
    input.sessionId,
    input.expectedStoreId,
  );
  if (tools.length > 4096) throw new AgentError('recovery_too_large');
  return partitionRecoveryHistory(db, input.sessionId, tools);
}

export function readRecoveryToolHistory(
  db: SqliteOperations,
  input: Parameters<Store['readRecoveryToolHistory']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    if (
      input.reconciledOnly &&
      !db.row(
        'SELECT root_session_id FROM session_reconciliation WHERE root_session_id=?',
        input.sessionId,
      )
    ) {
      db.db.run('COMMIT');
      return [];
    }
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
    const result = withReconciledFrontier(db, input, () => readUnstartedModelHistory(db, input));
    db.db.run('COMMIT');
    return result.histories;
  } catch (error) {
    return db.rollback(error);
  }
}

export function stoppedModelHistory(
  db: SqliteOperations,
  runId: string,
): StoppedModelHistory | null {
  if (!db.row('SELECT id FROM run WHERE id=? AND cancel_requested=1', runId)) return null;
  const stop = userStopCommand(db, runId) ?? null;
  const assistant = db.row(
    `SELECT m.id,m.seq,m.source_json,e.id AS model_id,e.result_json,e.result_revision,e.session_id
     FROM execution e JOIN run r ON r.id=e.run_id JOIN message m ON m.run_id=r.id
       AND m.session_id=e.session_id AND m.role='assistant' AND m.status='complete'
       AND json_array_length(json_extract(m.source_json,'$.sourceIds'))=1
       AND json_extract(m.source_json,'$.sourceIds[0]')=e.id
     WHERE r.id=? AND e.kind='model' AND e.state='succeeded' AND e.session_id=r.session_id
       AND e.origin_command_id=r.origin_command_id AND e.origin_store_id=r.origin_store_id
     ORDER BY m.seq DESC LIMIT 1`,
    runId,
  );
  if (!assistant) return null;
  const result = parse(assistant.result_json);
  const message = parse(assistant.source_json);
  if (
    result.content !== message.content ||
    canonicalJson(result.toolCalls ?? []) !== canonicalJson(message.toolCalls ?? []) ||
    canonicalJson(result.modelOutput ?? null) !== canonicalJson(message.modelOutput ?? null)
  )
    return unavailable();
  const count =
    result.modelOutput === undefined
      ? Array.isArray(result.toolCalls)
        ? result.toolCalls.length
        : 0
      : verifyModelOutput(
          db,
          result.modelOutput,
          db.row('SELECT * FROM execution WHERE id=?', assistant.model_id!)!,
        ).toolCallCount;
  if (!count) return null;
  return {
    executionId: String(assistant.model_id),
    sessionId: String(assistant.session_id),
    runId,
    bindingDigest: hash({
      stop,
      model: String(assistant.model_id),
      revision: String(assistant.result_revision),
      result,
      assistant: String(assistant.id),
      seq: String(assistant.seq),
      message,
    }),
  };
}

function reconciledStoppedModelHistories(db: SqliteOperations, rootSessionId: string) {
  const runs = db.rows(
    'SELECT r.id FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id=? AND r.is_active=1 AND r.cancel_requested=1 ORDER BY r.id LIMIT 4097',
    rootSessionId,
  );
  if (runs.length > 4096) throw new AgentError('recovery_too_large');
  return runs
    .map((run) => stoppedModelHistory(db, String(run.id)))
    .filter((history) => history !== null);
}

export function matchesStoppedModelProof(
  history: StoppedModelHistory,
  proof: StoppedModelProof | undefined,
): proof is StoppedModelProof {
  return (
    proof?.executionId === history.executionId &&
    proof.runId === history.runId &&
    proof.sessionId === history.sessionId &&
    proof.bindingDigest === history.bindingDigest
  );
}

export function validateStoppedModelProofs(
  histories: StoppedModelHistory[],
  proofs: StoppedModelProof[] = [],
) {
  const byModel = new Map(proofs.map((proof) => [proof.executionId, proof]));
  if (
    proofs.length !== histories.length ||
    histories.some(
      (history) => !matchesStoppedModelProof(history, byModel.get(history.executionId)),
    )
  )
    throw new AgentError('recovery_tool_history_changed');
  return byModel;
}

export function readStoppedModelHistory(
  db: SqliteOperations,
  input: Parameters<Store['readStoppedModelHistory']>[0],
): StoppedModelHistory[] {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    let histories: StoppedModelHistory[] = [];
    if ('runId' in input) {
      if (
        !db.row(
          'SELECT r.id FROM run r JOIN command c ON r.origin_command_id=c.id WHERE r.id=? AND r.session_id=? AND r.origin_store_id=? AND c.subject_id=?',
          input.runId,
          input.sessionId,
          input.expectedStoreId,
          input.subjectId,
        )
      )
        throw new AgentError('operation_unverifiable');
      const history = stoppedModelHistory(db, input.runId);
      if (history) histories = [history];
    } else if (
      !input.reconciledOnly ||
      db.row(
        'SELECT root_session_id FROM session_reconciliation WHERE root_session_id=?',
        input.sessionId,
      )
    ) {
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
      histories = withReconciledFrontier(db, input, () =>
        reconciledStoppedModelHistories(db, input.sessionId),
      );
    }
    db.db.run('COMMIT');
    return histories;
  } catch (error) {
    return db.rollback(error);
  }
}
