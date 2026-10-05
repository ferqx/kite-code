import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ContextSelection, type Json } from '../types';
import { activeCompression, historyOnlyCompression } from './compression-operations';
import { filter, pairBoundary, selected } from './context-selection-operations';
import { applyNamespacePlan, validateNamespacePlan } from './fork-namespaces';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const parse = <T>(value: Row[string] | undefined): T => JSON.parse(String(value)) as T;
function creator(db: SqliteOperations, sessionId: string, subjectId: string): Row {
  const row = db.row('SELECT * FROM session WHERE id=?', sessionId);
  if (!row) throw new AgentError('session_not_found');
  const command = db.row(
    "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
    row.root_id!,
  );
  if (!command || command.subject_id !== subjectId) throw new AgentError('permission_denied');
  return row;
}
export function messageOriginRow(db: SqliteOperations, row: Row, subjectId: string): Row {
  let current = row;
  const visited = new Set<string>();
  while (current.fork_source_message_id !== null && current.fork_source_message_id !== undefined) {
    if (visited.has(String(current.id)) || visited.size >= 64)
      throw new AgentError('fork_origin_unverifiable');
    visited.add(String(current.id));
    const session = creator(db, String(current.session_id), subjectId);
    const command = db.row(
      "SELECT request_json FROM command WHERE session_id=? AND kind='session.create'",
      session.id!,
    );
    if (!command || !parse<Record<string, Json>>(command.request_json).fork)
      throw new AgentError('fork_origin_unverifiable');
    const next = db.row('SELECT * FROM message WHERE id=?', current.fork_source_message_id!);
    if (
      !next ||
      current.role !== next.role ||
      current.status !== next.status ||
      current.source_json !== next.source_json
    )
      throw new AgentError('fork_origin_unverifiable');
    creator(db, String(next.session_id), subjectId);
    if (
      canonicalJson(
        db
          .rows(
            'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal',
            current.id!,
          )
          .map((p) => [
            String(p.ordinal),
            String(p.kind),
            String(p.content_version),
            String(p.revision),
            String(p.json),
          ]),
      ) !==
      canonicalJson(
        db
          .rows(
            'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal',
            next.id!,
          )
          .map((p) => [
            String(p.ordinal),
            String(p.kind),
            String(p.content_version),
            String(p.revision),
            String(p.json),
          ]),
      )
    )
      throw new AgentError('fork_origin_unverifiable');
    current = next;
  }
  creator(db, String(current.session_id), subjectId);
  return current;
}
export function getMessageOrigin(
  db: SqliteOperations,
  input: Parameters<Store['getMessageOrigin']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    creator(db, input.sessionId, input.subjectId);
    const message = db.row(
      'SELECT * FROM message WHERE id=? AND session_id=?',
      input.messageId,
      input.sessionId,
    );
    if (!message) throw new AgentError('message_not_found');
    const actual = messageOriginRow(db, message, input.subjectId);
    if (
      message.fork_source_message_id &&
      db.row(
        "SELECT message_id FROM message_part WHERE message_id=? AND (kind<>'text' OR content_version<>1) LIMIT 1",
        actual.id!,
      )
    )
      throw new AgentError('fork_content_unsupported');
    const result = { message: db.message(actual), subjectId: input.subjectId };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function forkSession(db: SqliteOperations, input: Parameters<Store['forkSession']>[0]) {
  validateNamespacePlan(input.namespacePlan);
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.newSessionId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId) ||
      !input.title ||
      Buffer.byteLength(input.title) > 4096
    )
      throw new AgentError('invalid_fork');
    const request: Json = {
      kind: 'session.create',
      title: input.title,
      fork: {
        sourceSessionId: input.sourceSessionId,
        expectedContextSelectionId: input.expectedContextSelectionId,
        boundary: input.boundary === undefined ? 'current' : (input.boundary as unknown as Json),
      },
    };
    const digest = hash(request);
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.origin_store_id !== input.expectedStoreId ||
        prior.session_id !== input.newSessionId ||
        prior.subject_id !== input.subjectId ||
        prior.request_digest !== digest
      )
        throw new AgentError('command_conflict');
      const session = db.row('SELECT * FROM session WHERE id=?', input.newSessionId)!;
      const snapshot = db.row(
        "SELECT request_json FROM context_snapshot WHERE id=? AND kind='selection'",
        String(parse<Record<string, Json>>(prior.receipt_json).selectionId),
      );
      if (!snapshot) throw new AgentError('context_receipt_invalid');
      return {
        command: db.command(prior),
        session: db.session(session),
        selection: parse<ContextSelection>(snapshot.request_json),
        omittedExtensionState:
          parse<Record<string, Json>>(prior.receipt_json).omittedExtensionState === true,
        namespaceReport: parse<Record<string, Json>>(prior.receipt_json)
          .namespaceReport as unknown as import('../types').ForkNamespaceReport[] | undefined,
      };
    }
    const source = creator(db, input.sourceSessionId, input.subjectId);
    if (source.parent_id !== null) throw new AgentError('group_root_required');
    if (source.delete_requested) throw new AgentError('session_not_found');
    if (source.context_selection_id !== input.expectedContextSelectionId)
      throw new AgentError('context_selection_changed');
    if (
      db.row(
        'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1 LIMIT 1',
        source.id!,
      ) ||
      db.row(
        "SELECT id FROM execution WHERE root_session_id=? AND state IN('planned','dispatching','running','outcome_unknown') LIMIT 1",
        source.id!,
      )
    )
      throw new AgentError('context_execution_unsettled');
    if (db.row('SELECT id FROM session WHERE id=?', input.newSessionId))
      throw new AgentError('identity_conflict');
    const selection = selected(db, source);
    let upper = BigInt(source.next_seq!);
    if (input.boundary === null) upper = 0n;
    else if (input.boundary !== undefined) {
      if (
        !/^(0|[1-9][0-9]*)$/.test(input.boundary.seq) ||
        BigInt(input.boundary.seq) > 9223372036854775807n
      )
        throw new AgentError('invalid_context_cursor');
      const boundary = db.row(
        `SELECT * FROM message WHERE id=? AND session_id=? AND seq=? AND status='complete' AND ${historyOnlyCompression()}`,
        input.boundary.messageId,
        source.id!,
        BigInt(input.boundary.seq),
      );
      const f = filter(selection, 'seq');
      if (
        !boundary ||
        !db.row(`SELECT id FROM message WHERE id=? AND ${f.sql}`, boundary.id!, ...f.args)
      )
        throw new AgentError('context_boundary_invalid');
      upper = BigInt(input.boundary.seq);
    }
    pairBoundary(db, String(source.id), selection, String(upper));
    const selectionId = randomUUID();
    db.run(
      'INSERT INTO session(id,workspace_id,root_id,title,context_selection_id) VALUES(?,?,?,?,?)',
      input.newSessionId,
      source.workspace_id!,
      input.newSessionId,
      input.title,
      selectionId,
    );
    applyNamespacePlan(db, input, String(upper));
    db.insertCommand(
      {
        expectedStoreId: input.expectedStoreId,
        commandId: input.commandId,
        sessionId: input.newSessionId,
        subjectId: input.subjectId,
      } as Parameters<SqliteOperations['insertCommand']>[0],
      request,
      digest,
      'applied',
      {
        sessionId: input.newSessionId,
        selectionId,
        sourceSessionId: input.sourceSessionId,
        sourceSelectionId: input.expectedContextSelectionId,
        sourceUpperSeq: String(upper),
        omittedExtensionState:
          !input.namespacePlan || input.namespacePlan.report.some((r) => r.omitted > 0),
        ...(input.namespacePlan
          ? { namespaceReport: input.namespacePlan.report as unknown as Json }
          : {}),
      },
    );
    const f = filter(selection, 'seq');
    for (const row of db.rows(
      `SELECT * FROM message WHERE session_id=? AND seq<=? AND ${f.sql} AND ${historyOnlyCompression()} ORDER BY seq`,
      source.id!,
      upper,
      ...f.args,
    )) {
      const original = messageOriginRow(db, row, input.subjectId),
        id = `fork-message-${hash([input.newSessionId, String(row.id)])}`;
      db.run(
        'INSERT INTO message(id,session_id,run_id,seq,role,status,source_json,fork_source_message_id) VALUES(?,?,NULL,?,?,?,?,?)',
        id,
        input.newSessionId,
        row.seq!,
        row.role!,
        row.status!,
        row.source_json!,
        original.id!,
      );
      db.run(
        'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) SELECT ?,ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=?',
        id,
        row.id!,
      );
    }
    for (const row of db.rows(
      `SELECT * FROM context_snapshot WHERE session_id=? AND kind='result_ref' AND seq<=? AND COALESCE(json_extract(request_json,'$.pendingInput'),0)=0 AND ${f.sql}`,
      source.id!,
      upper,
      ...f.args,
    )) {
      const provenance = parse<Record<string, Json>>(row.request_json);
      db.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind,seq,execution_id,result_revision,inclusion,origin_store_id,subject_id) VALUES(?,?,?,'[]',?,'result_ref',?,?,?,?,?,?)",
        `fork-result-${hash([input.newSessionId, String(row.id)])}`,
        input.newSessionId,
        selectionId,
        canonicalJson({
          ...provenance,
          forkOrigin: {
            sessionId: String(source.id),
            sourceId: String(row.id),
            storeId: input.expectedStoreId,
          },
        }),
        row.seq!,
        row.execution_id!,
        row.result_revision!,
        row.inclusion!,
        row.origin_store_id!,
        input.subjectId,
      );
    }
    const compression = activeCompression(db, String(source.id), selection.id, String(upper));
    if (compression) {
      const copy = {
        ...compression,
        id: `fork-compression-${hash([input.newSessionId, compression.id])}`,
        sessionId: input.newSessionId,
        contextSelectionId: selectionId,
      };
      db.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind,seq) VALUES(?,?,?,'[]',?,'compression',?)",
        copy.id,
        input.newSessionId,
        selectionId,
        canonicalJson(copy as unknown as Json),
        BigInt(copy.publishedSeq),
      );
    }
    const next: ContextSelection = {
      id: selectionId,
      sessionId: input.newSessionId,
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: String(upper),
      tailFromSeq: String(upper),
      ranges: upper > 0n ? [{ afterSeq: '0', throughSeq: String(upper) }] : [],
    };
    db.run(
      "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind) VALUES(?,?,?,'[]',?,'selection')",
      selectionId,
      input.newSessionId,
      selectionId,
      canonicalJson(next as unknown as Json),
    );
    db.run('UPDATE session SET next_seq=MAX(next_seq,?) WHERE id=?', upper, input.newSessionId);
    db.event(input.newSessionId, input.newSessionId, 'session.forked');
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!),
      session: db.session(db.row('SELECT * FROM session WHERE id=?', input.newSessionId)!),
      selection: next,
      omittedExtensionState:
        !input.namespacePlan || input.namespacePlan.report.some((r) => r.omitted > 0),
      namespaceReport: input.namespacePlan?.report,
    };
  });
}
