import { canonicalJson } from '../../json';
import type { PlanExecutionInput, Store } from '../port';
import { AgentError, type CompressionRecord, type Json } from '../types';
import { filter, selected } from './context-selection-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { assertInputBoundary } from './input-operations';
import { identity, sessionScope } from './model-input-operations';
import type { SqliteOperations } from './operations';
export const historyOnlyCompression = (alias = 'message') =>
  `NOT EXISTS(SELECT 1 FROM execution compression_execution JOIN json_each(json_extract(${alias}.source_json,'$.sourceIds')) compression_origin ON compression_origin.value=compression_execution.id WHERE ${alias}.role='assistant' AND compression_execution.kind='model' AND json_extract(compression_execution.decision_source_json,'$.compressionId') IS NOT NULL)`;
export function activeCompression(
  db: SqliteOperations,
  sessionId: string,
  selectionId: string,
  upper: string,
): CompressionRecord | undefined {
  const row = db.row(
    "SELECT request_json,kind FROM context_snapshot WHERE session_id=? AND selection_id=? AND kind IN('compression','compression_reset') AND seq<=? ORDER BY seq DESC LIMIT 1",
    sessionId,
    selectionId,
    BigInt(upper),
  );
  return row?.kind === 'compression'
    ? (JSON.parse(String(row.request_json)) as CompressionRecord)
    : undefined;
}
export function beginCompression(
  db: SqliteOperations,
  input: Parameters<Store['beginCompression']>[0],
): CompressionRecord {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
    if (!run) throw new AgentError('run_not_active');
    assertNoExecutionGroupFence(db, String(run.session_id));
    db.active(input.owner, String(run.origin_command_id), input.runId);
    assertInputBoundary(db, input.runId);
    const session = db.row('SELECT * FROM session WHERE id=?', run.session_id!)!;
    if (session.context_selection_id !== input.expectedContextSelectionId)
      throw new AgentError('context_selection_changed');
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.executionId) ||
      !input.compressor.id ||
      !input.compressor.version ||
      Buffer.byteLength(canonicalJson(input.compressor as unknown as Json)) > 32768 ||
      !['manual', 'automatic'].includes(input.trigger)
    )
      throw new AgentError('compression_configuration_invalid');
    const current = activeCompression(
      db,
      String(session.id),
      String(session.context_selection_id),
      String(session.next_seq),
    );
    const prior = db.row(
      'SELECT request_json FROM context_snapshot WHERE id=?',
      `compression-${input.executionId}`,
    );
    if (prior) {
      const record = JSON.parse(String(prior.request_json)) as CompressionRecord;
      if (
        record.runId !== input.runId ||
        record.contextSelectionId !== input.expectedContextSelectionId ||
        canonicalJson(record.compressor as unknown as Json) !==
          canonicalJson(input.compressor as unknown as Json) ||
        record.trigger !== input.trigger
      )
        throw new AgentError('compression_conflict');
      return record;
    }
    const selectionFilter = filter(selected(db, session), 'seq');
    if (
      db.row(
        `SELECT message.id FROM message JOIN message_part part ON part.message_id=message.id WHERE message.session_id=? AND message.status='complete' AND ${selectionFilter.sql} AND (part.kind<>'text' OR part.content_version<>1) LIMIT 1`,
        session.id!,
        ...selectionFilter.args,
      )
    )
      throw new AgentError('compression_content_unsupported');
    if (
      !db.row(
        `SELECT id FROM message WHERE session_id=? AND seq>? AND status='complete' AND ${historyOnlyCompression()} AND ${selectionFilter.sql} LIMIT 1`,
        session.id!,
        BigInt(current?.coveredThroughSeq ?? '0'),
        ...selectionFilter.args,
      ) &&
      !db.row(
        `SELECT id FROM context_snapshot WHERE session_id=? AND kind='result_ref' AND seq>? AND COALESCE(json_extract(request_json,'$.pendingInput'),0)=0 AND ${selectionFilter.sql} LIMIT 1`,
        session.id!,
        BigInt(current?.coveredThroughSeq ?? '0'),
        ...selectionFilter.args,
      )
    )
      throw new AgentError('compression_no_new_messages');
    const record: CompressionRecord = {
      id: `compression-${input.executionId}`,
      originSessionId: String(session.id),
      originCompressionId: `compression-${input.executionId}`,
      sessionId: String(session.id),
      contextSelectionId: String(session.context_selection_id),
      originStoreId: input.expectedStoreId,
      modelExecutionId: input.executionId,
      runId: input.runId,
      coveredThroughSeq: String(session.next_seq),
      publishedSeq: '0',
      previousCompressionId: current?.id ?? null,
      compressor: input.compressor,
      trigger: input.trigger,
    };
    db.run(
      "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind) VALUES(?,?,?,'[]',?,'compression_pending')",
      record.id,
      record.sessionId,
      record.contextSelectionId,
      canonicalJson(record as unknown as Json),
    );
    return record;
  });
}
export function verifyCompressionModel(db: SqliteOperations, input: PlanExecutionInput): void {
  const source = input.decisionSource as Record<string, Json>;
  if (source?.compressionId === undefined) return;
  const row = db.row(
    "SELECT request_json FROM context_snapshot WHERE id=? AND kind='compression_pending'",
    String(source.compressionId),
  );
  if (!row) throw new AgentError('compression_unverifiable');
  const record = JSON.parse(String(row.request_json)) as CompressionRecord;
  if (
    record.modelExecutionId !== input.executionId ||
    record.runId !== input.runId ||
    record.sessionId !== input.sessionId ||
    record.originStoreId !== input.expectedStoreId
  )
    throw new AgentError('compression_unverifiable');
}
export function commitCompression(
  db: SqliteOperations,
  input: Parameters<Store['commitCompression']>[0],
): CompressionRecord {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const row = db.row(
      "SELECT * FROM context_snapshot WHERE id=? AND kind IN('compression_pending','compression')",
      input.compressionId,
    );
    if (!row) throw new AgentError('compression_unverifiable');
    const record = JSON.parse(String(row.request_json)) as CompressionRecord;
    if (record.runId !== input.runId || record.originStoreId !== input.expectedStoreId)
      throw new AgentError('compression_unverifiable');
    db.owner(input.owner, record.sessionId);
    if (row.kind === 'compression') return record;
    const run = db.row('SELECT * FROM run WHERE id=?', input.runId)!;
    db.active(input.owner, String(run.origin_command_id), input.runId);
    assertInputBoundary(db, input.runId);
    const session = db.row('SELECT * FROM session WHERE id=?', record.sessionId)!;
    if (session.context_selection_id !== record.contextSelectionId)
      throw new AgentError('context_selection_changed');
    const execution = db.row(
      'SELECT * FROM execution WHERE id=? AND run_id=? AND session_id=?',
      record.modelExecutionId,
      input.runId,
      record.sessionId,
    );
    if (
      !execution ||
      execution.origin_store_id !== input.expectedStoreId ||
      execution.state !== 'succeeded' ||
      String(execution.owner_generation) !== input.owner.generation ||
      execution.cancel_requested ||
      JSON.parse(String(execution.decision_source_json)).compressionId !== record.id
    )
      throw new AgentError('compression_unverifiable');
    const value = JSON.parse(String(execution.result_json)) as Record<string, Json>;
    if (value.modelOutput) {
      const output = value.modelOutput as Record<string, Json>;
      if (
        output.complete !== true ||
        output.toolCallCount !== 0 ||
        BigInt(String(output.contentBytes)) === 0n
      )
        throw new AgentError('compression_summary_invalid');
    } else if (
      typeof value.content !== 'string' ||
      !value.content.trim() ||
      (Array.isArray(value.toolCalls) && value.toolCalls.length)
    )
      throw new AgentError('compression_summary_invalid');
    const modelMessage = db.row(
      "SELECT id,seq FROM message WHERE session_id=? AND run_id=? AND role='assistant' AND source_json IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(json_extract(source_json,'$.sourceIds')) ids WHERE ids.value=?) AND status='complete'",
      record.sessionId,
      record.runId,
      record.modelExecutionId,
    );
    // Command admission shares next_seq with Messages. A queued follow-up is not
    // part of this Run's input until applied; validate actual context additions.
    if (
      !modelMessage ||
      BigInt(modelMessage.seq!) <= BigInt(record.coveredThroughSeq) ||
      db.row(
        'SELECT id FROM message WHERE session_id=? AND seq>? AND id<>? LIMIT 1',
        record.sessionId,
        BigInt(record.coveredThroughSeq),
        modelMessage.id!,
      ) ||
      db.row(
        "SELECT id FROM context_snapshot WHERE session_id=? AND kind='result_ref' AND seq>? AND COALESCE(json_extract(request_json,'$.pendingInput'),0)=0 LIMIT 1",
        record.sessionId,
        BigInt(record.coveredThroughSeq),
      )
    )
      throw new AgentError('compression_context_changed');
    const previous = activeCompression(
      db,
      record.sessionId,
      record.contextSelectionId,
      String(session.next_seq),
    );
    if ((previous?.id ?? null) !== record.previousCompressionId)
      throw new AgentError('compression_conflict');
    db.allocateSessionSequence(record.sessionId);
    record.publishedSeq = String(
      db.row('SELECT next_seq FROM session WHERE id=?', record.sessionId)!.next_seq,
    );
    db.run(
      "UPDATE context_snapshot SET kind='compression',seq=?,request_json=? WHERE id=?",
      BigInt(record.publishedSeq),
      canonicalJson(record as unknown as Json),
      record.id,
    );
    db.event(record.sessionId, record.id, 'context.compressed', {
      executionId: record.modelExecutionId,
      coveredThroughSeq: record.coveredThroughSeq,
    });
    if (record.trigger === 'manual') {
      const command = db.row('SELECT kind FROM command WHERE id=?', run.origin_command_id!);
      if (command?.kind !== 'context.compress') throw new AgentError('compression_unverifiable');
      db.finishRun({ ...input, status: 'completed', requirements: input.requirements ?? [] });
    }
    return record;
  });
}

export function getCompressionOrigin(
  db: SqliteOperations,
  input: Parameters<Store['getCompressionOrigin']>[0],
): CompressionRecord {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const current = db.row(
      "SELECT c.subject_id FROM session s JOIN command c ON c.session_id=s.root_id AND c.kind='session.create' WHERE s.id=?",
      input.sessionId,
    );
    const row = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND session_id=? AND kind='compression'",
      input.compressionId,
      input.sessionId,
    );
    if (!current || current.subject_id !== input.subjectId || !row)
      throw new AgentError('compression_scope_denied');
    const record = JSON.parse(String(row.request_json)) as CompressionRecord;
    const original = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND session_id=? AND kind='compression'",
      record.originCompressionId,
      record.originSessionId,
    );
    const owner = db.row(
      "SELECT c.subject_id FROM session s JOIN command c ON c.session_id=s.root_id AND c.kind='session.create' WHERE s.id=?",
      record.originSessionId,
    );
    if (!original || owner?.subject_id !== input.subjectId)
      throw new AgentError('compression_unverifiable');
    const origin = JSON.parse(String(original.request_json)) as CompressionRecord;
    if (
      canonicalJson({
        ...record,
        id: origin.id,
        sessionId: origin.sessionId,
        contextSelectionId: origin.contextSelectionId,
      } as unknown as Json) !== canonicalJson(origin as unknown as Json)
    )
      throw new AgentError('compression_unverifiable');
    const execution = db.row('SELECT * FROM execution WHERE id=?', origin.modelExecutionId);
    if (
      execution?.state !== 'succeeded' ||
      execution.run_id !== origin.runId ||
      execution.session_id !== origin.originSessionId ||
      execution.origin_store_id !== origin.originStoreId
    )
      throw new AgentError('compression_unverifiable');
    try {
      const originalScope = {
        expectedStoreId: input.expectedStoreId,
        sessionId: origin.originSessionId,
        subjectId: input.subjectId,
      };
      identity(db, originalScope, sessionScope(db, originalScope), execution);
    } catch {
      throw new AgentError('compression_unverifiable');
    }
    db.db.run('COMMIT');
    return origin;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}

export function resetCompression(
  db: SqliteOperations,
  input: Parameters<Store['resetCompression']>[0],
): { reset: boolean } {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
    if (!run) throw new AgentError('run_not_found');
    const command = db.row(
      'SELECT kind,request_json FROM command WHERE id=?',
      run.origin_command_id!,
    );
    if (command?.kind !== 'context.compression.reset')
      throw new AgentError('compression_unverifiable');
    const request = JSON.parse(String(command.request_json));
    if (
      request.expectedContextSelectionId !== input.expectedContextSelectionId ||
      request.expectedCompressionId !== input.expectedCompressionId
    )
      throw new AgentError('compression_conflict');
    db.owner(input.owner, String(run.session_id));
    const id = `compression-reset-${run.origin_command_id}`;
    const prior = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND kind='compression_reset'",
      id,
    );
    if (prior) return JSON.parse(String(prior.request_json));
    db.active(input.owner, String(run.origin_command_id), input.runId);
    assertInputBoundary(db, input.runId);
    const session = db.row('SELECT * FROM session WHERE id=?', run.session_id!)!;
    if (session.context_selection_id !== input.expectedContextSelectionId)
      throw new AgentError('context_selection_changed');
    const active = activeCompression(
      db,
      String(run.session_id),
      input.expectedContextSelectionId,
      String(session.next_seq),
    );
    if (
      active &&
      (!input.expectedHighWaterSeq ||
        BigInt(input.expectedHighWaterSeq) !== BigInt(session.next_seq!))
    )
      throw new AgentError('compression_context_changed');
    if ((active?.id ?? null) !== input.expectedCompressionId)
      throw new AgentError('compression_conflict');
    const result = { reset: Boolean(active) };
    if (active) {
      db.allocateSessionSequence(String(run.session_id));
      db.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,seq,sources_json,request_json,kind) VALUES(?,?,?,?,'[]',?,'compression_reset')",
        id,
        run.session_id!,
        input.expectedContextSelectionId,
        db.row('SELECT next_seq FROM session WHERE id=?', run.session_id!)!.next_seq!,
        canonicalJson(result),
      );
      db.event(String(run.session_id), id, 'context.compression.reset');
    }
    db.finishRun({ ...input, status: 'completed', requirements: input.requirements ?? [] });
    return result;
  });
}
