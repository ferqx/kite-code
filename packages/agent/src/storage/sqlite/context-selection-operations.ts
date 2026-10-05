import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ContextSelection, type Json, type ResultContextSource } from '../types';
import { activeCompression, historyOnlyCompression } from './compression-operations';
import type { SqliteOperations } from './operations';
import { contextSnapshots } from './schema';

type Row = Record<string, string | number | bigint | null>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const parse = <T>(value: Row[string] | undefined): T => JSON.parse(String(value)) as T;
function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('invalid_context_cursor');
  return BigInt(value);
}
function session(db: SqliteOperations, id: string, root = false): Row {
  const row = db.row('SELECT * FROM session WHERE id=?', id);
  if (!row || row.delete_requested) throw new AgentError('session_not_found');
  if (root && row.parent_id !== null) throw new AgentError('group_root_required');
  return row;
}
function subject(db: SqliteOperations, id: string): string {
  const current = session(db, id);
  const creator =
    current.parent_id === null
      ? db.row("SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'", id)
      : db.row(
          `SELECT start.subject_id FROM command start JOIN execution carrier ON carrier.child_session_id=start.session_id JOIN command origin ON origin.id=carrier.origin_command_id JOIN session parent ON parent.id=carrier.session_id JOIN command root ON root.session_id=carrier.root_session_id AND root.kind='session.create' WHERE start.session_id=? AND start.kind='child.start' AND carrier.root_session_id=? AND parent.id=? AND parent.root_id=? AND start.subject_id=origin.subject_id AND start.subject_id=root.subject_id AND start.origin_store_id=carrier.origin_store_id`,
          id,
          String(current.root_id),
          String(current.parent_id),
          String(current.root_id),
        );
  if (!creator) throw new AgentError('context_scope_denied');
  return String(creator.subject_id);
}
export function selected(db: SqliteOperations, row: Row): ContextSelection {
  const snapshot = drizzle(db.db)
    .select({ request_json: contextSnapshots.requestJson })
    .from(contextSnapshots)
    .where(
      and(
        eq(contextSnapshots.id, String(row.context_selection_id)),
        eq(contextSnapshots.sessionId, String(row.id)),
        eq(contextSnapshots.kind, 'selection'),
      ),
    )
    .get();
  return snapshot
    ? parse(snapshot.request_json)
    : {
        id: String(row.context_selection_id),
        sessionId: String(row.id),
        previousSelectionId: null,
        boundaryMessageId: null,
        boundarySeq: '0',
        tailFromSeq: '0',
        ranges: [],
      };
}
function has(selection: ContextSelection, seq: string): boolean {
  const value = decimal(seq);
  return (
    value > decimal(selection.tailFromSeq) ||
    selection.ranges.some(
      (range) => value > decimal(range.afterSeq) && value <= decimal(range.throughSeq),
    )
  );
}
export function filter(
  selection: ContextSelection,
  column: string,
): { sql: string; args: string[] } {
  return {
    sql: `(${column}>?${selection.ranges.map(() => ` OR (${column}>? AND ${column}<=?)`).join('')})`,
    args: [
      selection.tailFromSeq,
      ...selection.ranges.flatMap((range) => [range.afterSeq, range.throughSeq]),
    ],
  };
}
function source(db: SqliteOperations, row: Row): ResultContextSource {
  const execution = db.row(
    'SELECT result_json,result_revision,origin_store_id,state FROM execution WHERE id=?',
    String(row.execution_id),
  );
  if (
    !execution ||
    String(execution.result_revision) !== String(row.result_revision) ||
    execution.origin_store_id !== row.origin_store_id
  )
    throw new AgentError('context_source_unverifiable');
  return {
    id: String(row.id),
    seq: String(row.seq),
    sessionId: String(row.session_id),
    createdSelectionId: String(row.selection_id),
    executionId: String(row.execution_id),
    resultRevision: String(row.result_revision),
    originStoreId: String(row.origin_store_id),
    inclusion: row.inclusion as ResultContextSource['inclusion'],
    result: parse<{ statusOnly?: boolean }>(row.request_json).statusOnly
      ? {
          outcome: String(execution.state),
          content: 'required_operation_settlement',
          details: {
            executionId: String(row.execution_id),
            resultRevision: String(row.result_revision),
            statusOnly: true,
          },
        }
      : parse(execution.result_json),
  };
}
function prior(
  db: SqliteOperations,
  input: { expectedStoreId: string; commandId: string; sessionId: string },
  request: Json,
  user: string,
): Row | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId)) throw new AgentError('invalid_command');
  const row = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (
    row &&
    (row.origin_store_id !== input.expectedStoreId ||
      row.session_id !== input.sessionId ||
      row.subject_id !== user ||
      row.request_digest !== hash(request))
  )
    throw new AgentError('command_conflict');
  return row;
}
function command(
  db: SqliteOperations,
  input: { expectedStoreId: string; commandId: string; sessionId: string },
  request: Json,
  user: string,
  receipt: Json,
  origin?: Row,
  accepted = false,
): Row {
  db.allocateSessionSequence(input.sessionId);
  const row = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!;
  db.run(
    'INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,input_context_selection_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    input.commandId,
    input.sessionId,
    row.next_seq,
    (request as { kind: string }).kind,
    user,
    hash(request),
    canonicalJson(request),
    accepted ? 'accepted' : 'applied',
    canonicalJson(receipt),
    input.expectedStoreId,
    origin?.root_work_command_id ?? input.commandId,
    origin?.root_work_seq ?? row.next_seq,
    session(db, input.sessionId).context_selection_id,
  );
  db.event(
    input.sessionId,
    input.commandId,
    accepted ? 'context.command_accepted' : 'context.command_applied',
  );
  return db.row('SELECT * FROM command WHERE id=?', input.commandId)!;
}
export function pairBoundary(
  db: SqliteOperations,
  id: string,
  selection: ContextSelection,
  boundary: string,
): void {
  const a = filter(selection, 'assistant.seq'),
    t = filter(selection, 'tool.seq');
  if (
    db.row(
      `SELECT assistant.id FROM message assistant, json_each(json_extract(assistant.source_json,'$.toolCalls')) call WHERE assistant.session_id=? AND assistant.seq<=? AND ${a.sql} AND ${historyOnlyCompression('assistant')} AND assistant.role='assistant' AND NOT EXISTS(SELECT 1 FROM message tool WHERE tool.session_id=assistant.session_id AND tool.role='tool' AND json_extract(tool.source_json,'$.toolCallId')=json_extract(call.value,'$.id') AND tool.seq>assistant.seq AND tool.seq<=? AND ${t.sql}) LIMIT 1`,
      id,
      boundary,
      ...a.args,
      boundary,
      ...t.args,
    )
  )
    throw new AgentError('context_boundary_unpaired');
  // Large original output stores calls in immutable Artifact segments. Its sealed
  // count must agree with exact persisted Tool result identities in this prefix.
  if (
    db.row(
      `SELECT assistant.id FROM message assistant WHERE assistant.session_id=? AND assistant.seq<=? AND ${a.sql} AND ${historyOnlyCompression('assistant')} AND assistant.role='assistant' AND COALESCE(json_extract(assistant.source_json,'$.modelOutput.toolCallCount'),0)>0 AND json_extract(assistant.source_json,'$.modelOutput.toolCallCount')<>(SELECT COUNT(DISTINCT execution.call_id) FROM execution JOIN message tool ON tool.session_id=assistant.session_id AND tool.role='tool' AND EXISTS(SELECT 1 FROM json_each(json_extract(tool.source_json,'$.sourceIds')) ids WHERE ids.value=execution.id) WHERE execution.kind='tool' AND json_extract(execution.decision_source_json,'$.modelExecutionId')=json_extract(assistant.source_json,'$.sourceIds[0]') AND tool.seq>assistant.seq AND tool.seq<=? AND ${t.sql}) LIMIT 1`,
      id,
      boundary,
      ...a.args,
      boundary,
      ...t.args,
    )
  )
    throw new AgentError('context_boundary_unpaired');
}
function originalRunSelection(
  db: SqliteOperations,
  input: Parameters<Store['readOriginalRunSelection']>[0],
) {
  const deny = (): never => {
    throw new AgentError('original_run_selection_unverifiable');
  };
  db.identity(input.expectedStoreId);
  const current = session(db, input.sessionId);
  if (subject(db, input.sessionId) !== input.subjectId)
    throw new AgentError('context_scope_denied');
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', input.runId, input.sessionId);
  const origin =
    run &&
    db.row(
      'SELECT * FROM command WHERE id=? AND session_id=?',
      run.origin_command_id!,
      input.sessionId,
    );
  if (
    !run ||
    !origin ||
    origin.subject_id !== input.subjectId ||
    origin.origin_store_id !== run.origin_store_id ||
    origin.input_context_selection_id !== run.context_selection_id ||
    !run.context_selection_id ||
    origin.request_digest !== hash(parse<Json>(origin.request_json))
  )
    deny();
  const upper = String(current.next_seq);
  decimal(upper);
  const creator = db.row(
    "SELECT * FROM command WHERE session_id=? AND kind='session.create' AND status='applied' ORDER BY seq LIMIT 1",
    input.sessionId,
  );
  const firstSelection = db.row(
    "SELECT * FROM command WHERE session_id=? AND kind='context.select' AND status='applied' ORDER BY seq LIMIT 1",
    input.sessionId,
  );
  let bytes = 0;
  const seen = new Set<string>();
  const load = (id: string, depth: number): ContextSelection => {
    if (depth > 64 || seen.has(id)) return deny();
    seen.add(id);
    const producing = db.rows(
      "SELECT * FROM command WHERE session_id=? AND status='applied' AND kind IN('context.select','session.create') AND json_extract(receipt_json,'$.selectionId')=? LIMIT 2",
      input.sessionId,
      id,
    );
    if (producing.length > 1) return deny();
    const raw = db.row('SELECT * FROM context_snapshot WHERE id=?', id);
    if (!raw) {
      if (producing.length) return deny();
      if (
        !creator ||
        parse<Record<string, Json>>(creator.receipt_json).selectionId !== undefined ||
        parse<Record<string, Json>>(creator.request_json).kind !== 'session.create' ||
        parse<Record<string, Json>>(creator.request_json).workspaceId !== current.workspace_id ||
        creator.subject_id !== input.subjectId ||
        creator.request_digest !== hash(parse<Json>(creator.request_json)) ||
        Object.keys(parse<Record<string, Json>>(creator.receipt_json)).sort().join(',') !==
          'sessionId' ||
        parse<Record<string, Json>>(creator.receipt_json).sessionId !== input.sessionId
      )
        return deny();
      const first = firstSelection;
      if (first) {
        if (
          parse<Record<string, Json>>(first.request_json).expectedContextSelectionId !== id ||
          (depth === 0 && BigInt(origin!.seq!) >= BigInt(first.seq!))
        )
          return deny();
      } else if (id !== current.context_selection_id) return deny();
      return {
        id,
        sessionId: input.sessionId,
        previousSelectionId: null,
        boundaryMessageId: null,
        boundarySeq: '0',
        tailFromSeq: '0',
        ranges: [],
      };
    }
    bytes += Buffer.byteLength(String(raw.request_json));
    if (
      bytes > 1024 * 1024 ||
      raw.session_id !== input.sessionId ||
      raw.kind !== 'selection' ||
      raw.selection_id !== id ||
      producing.length !== 1
    )
      return deny();
    const value = parse<ContextSelection>(raw.request_json);
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        'boundaryMessageId,boundarySeq,id,previousSelectionId,ranges,sessionId,tailFromSeq' ||
      value.id !== id ||
      value.sessionId !== input.sessionId ||
      !Array.isArray(value.ranges) ||
      value.ranges.length > 256 ||
      !(value.previousSelectionId === null || typeof value.previousSelectionId === 'string') ||
      !(value.boundaryMessageId === null || typeof value.boundaryMessageId === 'string')
    )
      return deny();
    for (const cursor of [value.boundarySeq, value.tailFromSeq])
      if (typeof cursor !== 'string' || decimal(cursor) > decimal(upper)) return deny();
    for (const range of value.ranges) {
      if (
        !range ||
        Object.keys(range).sort().join(',') !== 'afterSeq,throughSeq' ||
        typeof range.afterSeq !== 'string' ||
        typeof range.throughSeq !== 'string' ||
        decimal(range.afterSeq) >= decimal(range.throughSeq) ||
        decimal(range.throughSeq) > decimal(upper)
      )
        return deny();
    }
    const producer = producing[0]!;
    const request = parse<Record<string, Json>>(producer.request_json);
    const receipt = parse<Record<string, Json>>(producer.receipt_json);
    if (
      producer.subject_id !== input.subjectId ||
      producer.request_digest !== hash(request) ||
      request.kind !== producer.kind ||
      decimal(String(producer.seq)) > decimal(upper) ||
      BigInt(producer.seq!) >= BigInt(origin!.seq!)
    )
      return deny();
    if (producer.kind === 'context.select') {
      if (
        Object.keys(receipt).sort().join(',') !== 'outcome,selectionId' ||
        receipt.outcome !== 'context_selected' ||
        Object.keys(request).sort().join(',') !== 'boundary,expectedContextSelectionId,kind' ||
        request.expectedContextSelectionId !== value.previousSelectionId ||
        value.tailFromSeq !== String(BigInt(producer.seq!) - 1n)
      )
        return deny();
      const parent = load(value.previousSelectionId!, depth + 1);
      const boundary = request.boundary as { messageId: string; seq: string } | null;
      if (
        boundary === null
          ? value.boundaryMessageId !== null || value.boundarySeq !== '0'
          : !boundary ||
            Object.keys(boundary).sort().join(',') !== 'messageId,seq' ||
            boundary.messageId !== value.boundaryMessageId ||
            boundary.seq !== value.boundarySeq
      )
        return deny();
      if (
        boundary &&
        (!has(parent, boundary.seq) ||
          !db.row(
            "SELECT id FROM message WHERE id=? AND session_id=? AND seq=? AND status='complete'",
            boundary.messageId,
            input.sessionId,
            BigInt(boundary.seq),
          ))
      )
        return deny();
      const ranges = parent.ranges
        .map((range) => ({
          afterSeq: range.afterSeq,
          throughSeq: String(
            BigInt(range.throughSeq) > BigInt(value.boundarySeq)
              ? BigInt(value.boundarySeq)
              : BigInt(range.throughSeq),
          ),
        }))
        .filter((range) => BigInt(range.afterSeq) < BigInt(range.throughSeq));
      if (BigInt(value.boundarySeq) > BigInt(parent.tailFromSeq))
        ranges.push({ afterSeq: parent.tailFromSeq, throughSeq: value.boundarySeq });
      if (canonicalJson(ranges) !== canonicalJson(value.ranges)) return deny();
    } else {
      const keys = Object.keys(receipt);
      if (
        keys.some(
          (key) =>
            ![
              'sessionId',
              'selectionId',
              'sourceSessionId',
              'sourceSelectionId',
              'sourceUpperSeq',
              'omittedExtensionState',
              'namespaceReport',
            ].includes(key),
        ) ||
        receipt.sessionId !== input.sessionId ||
        typeof receipt.sourceSessionId !== 'string' ||
        typeof receipt.sourceSelectionId !== 'string' ||
        typeof receipt.omittedExtensionState !== 'boolean' ||
        value.previousSelectionId !== null ||
        value.boundaryMessageId !== null ||
        receipt.sourceUpperSeq !== value.boundarySeq ||
        value.tailFromSeq !== value.boundarySeq ||
        canonicalJson(value.ranges) !==
          canonicalJson(
            BigInt(value.boundarySeq) > 0n
              ? [{ afterSeq: '0', throughSeq: value.boundarySeq }]
              : [],
          )
      )
        return deny();
      const sourceSession = db.row(
        'SELECT * FROM session WHERE id=?',
        String(receipt.sourceSessionId),
      );
      if (
        !sourceSession ||
        sourceSession.workspace_id !== current.workspace_id ||
        sourceSession.parent_id !== null ||
        subject(db, String(sourceSession.id)) !== input.subjectId ||
        decimal(String(receipt.sourceUpperSeq)) > decimal(String(sourceSession.next_seq))
      )
        return deny();
      const fork = request.fork as Record<string, Json> | null;
      if (
        Object.keys(request).sort().join(',') !== 'fork,kind,title' ||
        !fork ||
        Object.keys(fork).sort().join(',') !==
          'boundary,expectedContextSelectionId,sourceSessionId' ||
        fork.sourceSessionId !== receipt.sourceSessionId ||
        fork.expectedContextSelectionId !== receipt.sourceSelectionId
      )
        return deny();
    }
    return value;
  };
  const selection = load(String(run!.context_selection_id), 0);
  return { selection, highWaterSeq: upper };
}

export function callContextSelection(
  db: SqliteOperations,
  method: string,
  args: unknown[],
  inTransaction = false,
): unknown {
  if (method === 'readOriginalRunSelection') {
    db.db.run('BEGIN');
    try {
      const result = originalRunSelection(
        db,
        args[0] as Parameters<Store['readOriginalRunSelection']>[0],
      );
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  if (method === 'listPendingJobResults') {
    const input = args[0] as Parameters<Store['listPendingJobResults']>[0];
    db.db.run('BEGIN');
    try {
      db.identity(input.expectedStoreId);
      session(db, input.sessionId);
      const snapshotCursor = db.metadata().lastChangeCursor;
      const after = input.afterCursor ?? '0',
        upper = input.upperCursor ?? snapshotCursor;
      decimal(after);
      decimal(upper);
      if (BigInt(upper) > BigInt(snapshotCursor) || BigInt(after) > BigInt(upper))
        throw new AgentError('cursor_ahead');
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new AgentError('invalid_context_cursor');
      const rows = db.rows(
        `SELECT e.id,e.result_revision,e.origin_store_id,e.context_selection_id,e.completed_cursor AS cursor FROM execution e WHERE e.kind='job' AND e.after_turn_json IS NULL AND e.delivery='pending' AND e.delivery_target_session_id=? AND e.state IN ('succeeded','failed','cancelled','outcome_unknown') AND e.completed_cursor>? AND e.completed_cursor<=? ORDER BY e.completed_cursor LIMIT ?`,
        input.sessionId,
        after,
        upper,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      const result = {
        jobs: page.map((row) => ({
          executionId: String(row.id),
          resultRevision: String(row.result_revision),
          originStoreId: String(row.origin_store_id),
          contextSelectionId: String(row.context_selection_id),
          completedCursor: String(row.cursor),
        })),
        nextAfterCursor: rows.length > limit ? String(page[page.length - 1]!.cursor) : null,
        highWaterCursor: upper,
        snapshotCursor,
      };
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  if (['getSelectedContext', 'getExpandedContext', 'getModelContext'].includes(method)) {
    const input = args[0] as Parameters<Store['getSelectedContext']>[0];
    db.db.run('BEGIN');
    try {
      db.identity(input.expectedStoreId);
      const current = session(db, input.sessionId);
      if (
        input.contextSelectionId !== undefined &&
        input.contextSelectionId !== current.context_selection_id
      )
        throw new AgentError('context_selection_changed');
      const selection = selected(db, current);
      const after = input.afterSeq ?? '0';
      const upper = input.upperSeq ?? String(current.next_seq);
      decimal(upper);
      decimal(after);
      if (BigInt(upper) > BigInt(current.next_seq!) || BigInt(after) > BigInt(upper))
        throw new AgentError('cursor_ahead');
      if (BigInt(after) > BigInt(current.next_seq!)) throw new AgentError('cursor_ahead');
      const messageLimit = input.messageLimit ?? 50,
        sourceLimit = input.sourceLimit ?? 50,
        byteLimit = input.byteLimit ?? 1024 * 1024;
      if (
        !Number.isSafeInteger(messageLimit) ||
        messageLimit < 1 ||
        messageLimit > 200 ||
        !Number.isSafeInteger(sourceLimit) ||
        sourceLimit < 1 ||
        sourceLimit > 100 ||
        !Number.isSafeInteger(byteLimit) ||
        byteLimit < 1024 ||
        byteLimit > 8 * 1024 * 1024 ||
        (input.afterSourceId?.length ?? 0) > 128
      )
        throw new AgentError('invalid_context_cursor');
      const compression =
        method === 'getExpandedContext'
          ? undefined
          : activeCompression(db, input.sessionId, selection.id, upper);
      const mf = filter(selection, 'seq'),
        sf = filter(selection, 'seq');
      if (method !== 'getSelectedContext') {
        const unsupported = db.row(
          `SELECT message.fork_source_message_id FROM message WHERE message.session_id=? AND message.seq>? AND message.seq<=? AND message.status='complete' AND ${mf.sql} AND ${historyOnlyCompression()} AND message.seq>${compression ? BigInt(compression.coveredThroughSeq) : 0n} AND (NOT EXISTS(SELECT 1 FROM message_part part WHERE part.message_id=message.id AND part.ordinal=0) OR EXISTS(SELECT 1 FROM message_part part WHERE part.message_id=message.id AND (part.kind<>'text' OR part.content_version<>1 OR part.ordinal<>0))) LIMIT 1`,
          input.sessionId,
          after,
          upper,
          ...mf.args,
        );
        if (unsupported)
          throw new AgentError(
            unsupported.fork_source_message_id
              ? 'fork_content_unsupported'
              : 'context_content_unsupported',
          );
      }
      const messageRows = db.rows(
        `SELECT * FROM message WHERE session_id=? AND seq>? AND seq<=? AND status='complete' AND ${mf.sql} AND ${historyOnlyCompression()} AND seq>${compression ? BigInt(compression.coveredThroughSeq) : 0n} ORDER BY seq LIMIT ?`,
        input.sessionId,
        after,
        upper,
        ...mf.args,
        messageLimit + 1,
      );
      const sourceRows = db.rows(
        `SELECT * FROM context_snapshot WHERE session_id=? AND kind='result_ref' AND COALESCE(json_extract(request_json,'$.pendingInput'),0)=0 AND id>? AND seq<=? AND ${sf.sql} AND seq>${compression ? BigInt(compression.coveredThroughSeq) : 0n} ORDER BY id LIMIT ?`,
        input.sessionId,
        input.afterSourceId ?? '',
        upper,
        ...sf.args,
        sourceLimit + 1,
      );
      const messages: ReturnType<SqliteOperations['message']>[] = [];
      const resultSources: ResultContextSource[] = [];
      let bytes = compression ? Buffer.byteLength(JSON.stringify(compression)) : 0;
      if (bytes > byteLimit) throw new AgentError('context_item_too_large');
      for (const row of messageRows.slice(0, messageLimit)) {
        const value = db.message(row),
          size = Buffer.byteLength(JSON.stringify(value));
        if (size > byteLimit) throw new AgentError('context_item_too_large');
        if (bytes + size > byteLimit) break;
        messages.push(value);
        bytes += size;
      }
      for (const row of sourceRows.slice(0, sourceLimit)) {
        const value = source(db, row),
          size = Buffer.byteLength(JSON.stringify(value));
        if (size > byteLimit) throw new AgentError('context_item_too_large');
        if (bytes + size > byteLimit) break;
        resultSources.push(value);
        bytes += size;
      }
      const value = {
        selection,
        ...(compression ? { compression } : {}),
        highWaterSeq: upper,
        messages,
        resultSources,
        nextAfterSeq: messageRows.length > messages.length ? (messages.at(-1)?.seq ?? after) : null,
        nextAfterSourceId:
          sourceRows.length > resultSources.length
            ? (resultSources.at(-1)?.id ?? input.afterSourceId ?? '')
            : null,
        snapshotCursor: db.metadata().lastChangeCursor,
      };
      db.db.run('COMMIT');
      return value;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  const mutate = () => {
    const input = args[0] as Parameters<Store['selectContext']>[0] &
      Parameters<Store['consumeJobResult']>[0] &
      Parameters<Store['includeResult']>[0];
    db.identity(input.expectedStoreId);
    const current = session(db, input.sessionId, method !== 'consumeJobResult');
    const user = subject(db, input.sessionId);
    const explicit = method !== 'consumeJobResult';
    if (explicit && input.subjectId !== user) throw new AgentError('permission_denied');
    const expected =
      method === 'consumeJobResult' ? input.contextSelectionId : input.expectedContextSelectionId;
    const request: Json =
      method === 'selectContext'
        ? { kind: 'context.select', expectedContextSelectionId: expected, boundary: input.boundary }
        : method === 'consumeJobResult'
          ? {
              kind: 'job_result.consume',
              contextSelectionId: expected,
              executionId: input.executionId,
              resultRevision: input.resultRevision,
              targetRunId: input.targetRunId ?? null,
              requiredRef: (input.requiredRef ?? null) as unknown as Json,
              requiredDiagnostic: input.requiredDiagnostic ?? false,
            }
          : {
              kind: 'result.include',
              expectedContextSelectionId: expected,
              executionId: input.executionId,
              resultRevision: input.resultRevision,
              targetRunId: input.targetRunId ?? null,
            };
    const existing = prior(db, input, request, user);
    if (existing) {
      const receipt = parse<{ selectionId?: string; sourceId?: string }>(existing.receipt_json);
      if (method === 'selectContext') {
        const stored = db.row(
          "SELECT request_json FROM context_snapshot WHERE id=? AND kind='selection'",
          receipt.selectionId!,
        );
        if (!stored) throw new AgentError('context_receipt_invalid');
        return { command: db.command(existing), selection: parse(stored.request_json) };
      }
      const stored = db.row(
        "SELECT * FROM context_snapshot WHERE id=? AND kind='result_ref'",
        receipt.sourceId!,
      );
      if (!stored) throw new AgentError('context_receipt_invalid');
      return { command: db.command(existing), source: source(db, stored) };
    }
    if (expected !== current.context_selection_id)
      throw new AgentError(
        method === 'consumeJobResult' ? 'context_rewound' : 'context_selection_changed',
      );
    const selection = selected(db, current);
    if (method === 'selectContext') {
      if (
        db.row(
          'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1 LIMIT 1',
          input.sessionId,
        ) ||
        db.row(
          "SELECT id FROM execution WHERE root_session_id=? AND state IN ('planned','dispatching','running','outcome_unknown') LIMIT 1",
          input.sessionId,
        )
      )
        throw new AgentError('context_execution_unsettled');
      let boundary = '0';
      if (input.boundary !== null) {
        decimal(input.boundary.seq);
        const message = db.row(
          `SELECT id,seq FROM message WHERE id=? AND session_id=? AND status='complete' AND ${historyOnlyCompression()}`,
          input.boundary.messageId,
          input.sessionId,
        );
        if (
          !message ||
          String(message.seq) !== input.boundary.seq ||
          !has(selection, input.boundary.seq)
        )
          throw new AgentError('context_boundary_invalid');
        boundary = input.boundary.seq;
      }
      pairBoundary(db, input.sessionId, selection, boundary);
      const ranges = selection.ranges
        .map((range) => ({
          afterSeq: range.afterSeq,
          throughSeq: String(
            BigInt(range.throughSeq) > BigInt(boundary)
              ? BigInt(boundary)
              : BigInt(range.throughSeq),
          ),
        }))
        .filter((range) => BigInt(range.afterSeq) < BigInt(range.throughSeq));
      if (BigInt(boundary) > BigInt(selection.tailFromSeq))
        ranges.push({ afterSeq: selection.tailFromSeq, throughSeq: boundary });
      if (ranges.length > 256) throw new AgentError('context_selection_too_complex');
      const next: ContextSelection = {
        id: randomUUID(),
        sessionId: input.sessionId,
        previousSelectionId: selection.id,
        boundaryMessageId: input.boundary?.messageId ?? null,
        boundarySeq: boundary,
        tailFromSeq: String(current.next_seq),
        ranges,
      };
      db.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind) VALUES(?,?,?,'[]',?,'selection')",
        next.id,
        input.sessionId,
        next.id,
        canonicalJson(next as unknown as Json),
      );
      db.run('UPDATE session SET context_selection_id=? WHERE id=?', next.id, input.sessionId);
      db.run(
        "UPDATE execution SET delivery='suppressed',delivery_reason='context_rewound' WHERE delivery_target_session_id=? AND delivery='pending'",
        input.sessionId,
      );
      db.run(
        "UPDATE command SET status='rejected',cancelled=1,receipt_json=CASE WHEN kind='job.report' THEN json_object('outcome','suppressed','reason','context_rewound') ELSE ? END WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND status='accepted'",
        canonicalJson({ outcome: 'context_rewound' }),
        input.sessionId,
      );
      const saved = command(db, input, request, user, {
        selectionId: next.id,
        outcome: 'context_selected',
      });
      db.event(input.sessionId, next.id, 'context.selected');
      return { command: db.command(saved), selection: next };
    }
    const revision = decimal(input.resultRevision);
    if (revision === 0n) throw new AgentError('result_revision_conflict');
    const execution = db.row(
      'SELECT e.*,c.subject_id FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
      input.executionId,
    );
    if (
      !execution ||
      execution.subject_id !== user ||
      (execution.delivery_target_session_id ?? execution.session_id) !== input.sessionId
    )
      throw new AgentError('context_result_scope_denied');
    if (
      String(execution.result_revision) !== input.resultRevision ||
      !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(execution.state))
    )
      throw new AgentError('result_revision_conflict');
    const reportConsumption = method === 'consumeJobResult' && execution.after_turn_json !== null;
    if (reportConsumption) {
      const reportRun =
        input.targetRunId &&
        db.row(
          'SELECT origin_command_id FROM run WHERE id=? AND session_id=?',
          input.targetRunId,
          input.sessionId,
        );
      const report =
        reportRun &&
        db.row(
          "SELECT request_json FROM command WHERE id=? AND kind='job.report'",
          reportRun.origin_command_id!,
        );
      if (
        !report ||
        parse<{ executionId: string }>(report.request_json).executionId !== input.executionId
      )
        throw new AgentError('result_not_pending');
    }
    let statusOnly = false;
    const diagnostic = method === 'consumeJobResult' && input.requiredDiagnostic === true;
    if (diagnostic && (!input.requiredRef || execution.state !== 'outcome_unknown'))
      throw new AgentError('required_result_unverifiable');
    if (method === 'consumeJobResult' && input.requiredRef) {
      const ref = input.requiredRef;
      const parent = input.targetRunId
        ? db.row(
            'SELECT * FROM run WHERE id=? AND session_id=?',
            input.targetRunId,
            input.sessionId,
          )
        : null;
      const metadata = db.row(
        "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
        ref.extensionId,
        input.sessionId,
        ref.recordKey,
      );
      const value = metadata ? parse<Record<string, Json>>(metadata.json) : null;
      const refs = parent
        ? parse<import('../types').RequirementRef[]>(parent.requirements_json)
        : [];
      if (
        !parent?.is_active ||
        parent.cancel_requested ||
        ref.runId !== parent.id ||
        ref.sessionId !== input.sessionId ||
        !refs.some(
          (actual) =>
            canonicalJson(actual as unknown as Json) === canonicalJson(ref as unknown as Json),
        ) ||
        !metadata ||
        String(metadata.revision) !== ref.revision ||
        metadata.origin_store_id !== input.expectedStoreId ||
        value?.kind !== 'operation_result' ||
        value.executionId !== input.executionId ||
        value.runId !== parent.id ||
        value.sessionId !== input.sessionId ||
        value.originStoreId !== input.expectedStoreId ||
        value.originCommandId !== execution.origin_command_id ||
        value.parentExecutionId !== execution.parent_execution_id ||
        value.rootWorkCommandId !== execution.root_work_command_id ||
        value.rootWorkSeq !== String(execution.root_work_seq) ||
        db.row('SELECT run_id FROM execution WHERE id=?', execution.parent_execution_id!)
          ?.run_id !== parent.id ||
        db.row('SELECT extension_id FROM command WHERE id=?', execution.origin_command_id!)
          ?.extension_id !== ref.extensionId ||
        value.contextSelectionId !== expected ||
        execution.root_work_command_id !== parent.root_work_command_id ||
        String(execution.root_work_seq) !== String(parent.root_work_seq) ||
        (execution.state === 'outcome_unknown' && !diagnostic)
      )
        throw new AgentError('required_result_unverifiable');
      db.active(input.owner, String(parent.origin_command_id), String(parent.id));
      if (diagnostic) statusOnly = true;
      if (!diagnostic && execution.delivery === 'suppressed') {
        if (execution.delivery_reason !== 'execution_cancel' || !execution.cancel_requested)
          throw new AgentError('result_not_pending');
        statusOnly = true;
      }
    }
    const active = db.row('SELECT * FROM run WHERE session_id=? AND is_active=1', input.sessionId);
    if (method === 'includeResult') {
      if (active) {
        if (input.targetRunId !== active.id) throw new AgentError('input_target_changed');
        const origin = db.row(
          'SELECT subject_id,cancelled FROM command WHERE id=?',
          active.origin_command_id!,
        );
        if (active.origin_store_id !== input.expectedStoreId || origin?.subject_id !== user)
          throw new AgentError('operation_unverifiable');
        if (
          active.cancel_requested ||
          origin.cancelled ||
          BigInt(active.root_work_seq!) <= BigInt(current.stop_boundary!)
        )
          throw new AgentError('input_target_stopped');
      } else if (input.targetRunId !== undefined) throw new AgentError('input_target_stopped');
    } else {
      db.owner(input.owner, input.sessionId);
      if (active) {
        if (input.targetRunId !== active.id) throw new AgentError('input_target_changed');
        db.active(input.owner, String(active.origin_command_id), String(active.id));
      } else if (input.targetRunId !== undefined) throw new AgentError('input_target_stopped');
      if (execution.origin_store_id !== input.expectedStoreId)
        throw new AgentError('operation_unverifiable');
      if (execution.context_selection_id !== expected) throw new AgentError('context_rewound');
      if (execution.kind !== 'job' || (execution.delivery !== 'pending' && !statusOnly))
        throw new AgentError('result_not_pending');
      if (
        (!statusOnly && execution.cancel_requested) ||
        BigInt(execution.root_work_seq!) <= BigInt(current.stop_boundary!)
      )
        throw new AgentError('result_delivery_cancelled');
      if (!statusOnly && !reportConsumption)
        db.active(input.owner, String(execution.origin_command_id));
    }
    const sf = filter(selection, 'seq');
    let existingSource = db.row(
      `SELECT * FROM context_snapshot WHERE session_id=? AND kind='result_ref' AND execution_id=? AND result_revision=? AND COALESCE(json_extract(request_json,'$.diagnostic'),0)=? AND ${sf.sql} ORDER BY seq LIMIT 1`,
      input.sessionId,
      input.executionId,
      input.resultRevision,
      diagnostic ? 1 : 0,
      ...sf.args,
    );
    if (!existingSource) {
      db.allocateSessionSequence(input.sessionId);
      const seq = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!.next_seq;
      const id = `result-${hash([input.sessionId, selection.id, input.executionId, input.resultRevision, diagnostic])}`;
      db.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind,seq,execution_id,result_revision,inclusion,origin_store_id,subject_id) VALUES(?,?,?,'[]',?,'result_ref',?,?,?,?,?,?)",
        id,
        input.sessionId,
        selection.id,
        canonicalJson({
          targetRunId: input.targetRunId ?? null,
          pendingInput: method === 'includeResult' && Boolean(active),
          statusOnly,
          diagnostic,
        }),
        seq,
        input.executionId,
        input.resultRevision,
        method === 'includeResult' ? 'explicit' : 'automatic',
        execution.origin_store_id,
        user,
      );
      existingSource = db.row('SELECT * FROM context_snapshot WHERE id=?', id)!;
      db.event(input.sessionId, id, 'context.result_included');
    }
    if (method === 'consumeJobResult' && !statusOnly)
      db.run(
        "UPDATE execution SET delivery='consumed',delivery_reason=NULL WHERE id=?",
        input.executionId,
      );
    const saved = command(
      db,
      input,
      request,
      user,
      {
        sourceId: String(existingSource.id),
        executionId: input.executionId,
        resultRevision: input.resultRevision,
        outcome: method === 'includeResult' ? 'result_included' : 'result_consumed',
      },
      method === 'consumeJobResult' ? execution : (active ?? undefined),
      method === 'includeResult' &&
        Boolean(active) &&
        Boolean(parse<{ pendingInput?: boolean }>(existingSource.request_json).pendingInput),
    );
    if (
      method === 'includeResult' &&
      active &&
      parse<{ pendingInput?: boolean }>(existingSource.request_json).pendingInput
    ) {
      db.run(
        "UPDATE command SET status='accepted',input_target_run_id=?,receipt_json=? WHERE id=?",
        active.id!,
        canonicalJson({
          sourceId: String(existingSource.id),
          executionId: input.executionId,
          resultRevision: input.resultRevision,
          runId: String(active.id),
          outcome: 'result_queued',
        }),
        saved.id!,
      );
      db.event(input.sessionId, String(saved.id), 'command.accepted');
    }
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', saved.id!)!),
      source: source(db, existingSource),
    };
  };
  return inTransaction ? mutate() : db.tx(mutate);
}
