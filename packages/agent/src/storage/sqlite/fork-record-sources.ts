import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ExtensionRecord, type ForkRecordSources, type Json } from '../types';
import { historyOnlyCompression } from './compression-operations';
import { filter, selected } from './context-selection-operations';
import { messageOriginRow } from './fork-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
type Input = Parameters<Store['readForkRecordSources']>[0];
const fail = (): never => {
  throw new AgentError('fork_record_source_unverifiable');
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]) {
  const obj = object(value);
  if (Object.keys(obj).some((key) => !keys.includes(key))) return fail();
  return obj;
}
function parse(value: unknown) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fail();
  }
}
function session(db: SqliteOperations, id: string, subjectId: string): Row {
  const row = db.row('SELECT * FROM session WHERE id=?', id);
  if (!row || row.delete_requested || row.parent_id !== null) return fail();
  const creator = db.row("SELECT * FROM command WHERE session_id=? AND kind='session.create'", id);
  if (!creator || creator.subject_id !== subjectId || creator.status !== 'applied') return fail();
  return row;
}
function record(row: Row): ExtensionRecord {
  return {
    extensionId: String(row.extension_id),
    sessionId: String(row.scope_id),
    key: String(row.key),
    revision: String(row.revision),
    contentType: String(row.content_type),
    contentVersion: Number(row.content_version),
    originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
    value: parse(row.json),
    forkProvenance: row.fork_provenance_json === null ? null : parse(row.fork_provenance_json),
  };
}
/** Called inside the caller's existing final transaction as well as a standalone read transaction. */
export function forkRecordSources(db: SqliteOperations, input: Input): ForkRecordSources {
  db.identity(input.expectedStoreId);
  if (
    Object.keys(input).some(
      (key) =>
        !['expectedStoreId', 'sessionId', 'subjectId', 'extensionId', 'localKey'].includes(key),
    ) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.extensionId)
  )
    return fail();
  if (typeof input.localKey !== 'string' || !input.localKey || input.localKey.length > 256)
    return fail();
  const current = session(db, input.sessionId, input.subjectId);
  const records = new Map<string, ExtensionRecord>();
  const proofs: unknown[] = [];
  let bytes = 0;
  const budget = (value: unknown) => {
    bytes += Buffer.byteLength(canonicalJson(value as Json));
    if (bytes > 1024 * 1024) throw new AgentError('dispatch_read_set_invalid');
  };
  const lineage: {
    sessionId: string;
    upper: bigint;
    selection: import('../types').ContextSelection | null;
  }[] = [];
  const ancestorIds = new Set<string>([input.sessionId]);
  let cursor = current;
  for (;;) {
    const creator = db.row(
      "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
      cursor.id!,
    );
    if (!creator) return fail();
    const request = object(parse(creator.request_json));
    if (request.fork === undefined) break;
    if (lineage.length >= 64) return fail();
    const fork = object(request.fork),
      receipt = object(parse(creator.receipt_json));
    if (
      typeof fork.sourceSessionId !== 'string' ||
      typeof fork.expectedContextSelectionId !== 'string' ||
      receipt.sessionId !== cursor.id ||
      receipt.sourceSessionId !== fork.sourceSessionId ||
      receipt.sourceSelectionId !== fork.expectedContextSelectionId ||
      !/^(0|[1-9][0-9]*)$/.test(String(receipt.sourceUpperSeq)) ||
      BigInt(String(receipt.sourceUpperSeq)) > 9223372036854775807n ||
      ancestorIds.has(fork.sourceSessionId)
    )
      return fail();
    const source = session(db, fork.sourceSessionId, input.subjectId);
    if (source.workspace_id !== current.workspace_id) return fail();
    const snapshot = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND session_id=? AND kind='selection'",
      fork.expectedContextSelectionId,
      fork.sourceSessionId,
    );
    const projection = [
      String(cursor.id),
      String(source.id),
      creator.origin_store_id,
      creator.request_json,
      creator.receipt_json,
      snapshot?.request_json ?? null,
    ];
    budget(projection);
    proofs.push(projection);
    lineage.push({
      sessionId: String(source.id),
      upper: BigInt(String(receipt.sourceUpperSeq)),
      selection: snapshot ? parse(snapshot.request_json) : null,
    });
    ancestorIds.add(String(source.id));
    cursor = source;
  }
  const visiting = new Set<string>();
  function walk(sessionId: string, key: string, depth: number) {
    if (depth > 64) return fail();
    const identity = canonicalJson([input.extensionId, sessionId, key]);
    if (visiting.has(identity)) return fail();
    if (records.has(identity)) return;
    if (records.size >= 64) throw new AgentError('dispatch_read_set_invalid');
    const target = session(db, sessionId, input.subjectId);
    if (target.workspace_id !== current.workspace_id) return fail();
    const row = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      input.extensionId,
      sessionId,
      key,
    );
    if (!row) return fail();
    if (
      Buffer.byteLength(String(row.json)) > 1024 * 1024 ||
      Buffer.byteLength(String(row.fork_provenance_json)) > 1024 * 1024
    )
      throw new AgentError('dispatch_read_set_invalid');
    const actual = record(row);
    budget(actual);
    records.set(identity, actual);
    if (row.fork_provenance_json === null) {
      if (depth === 0) return fail();
      return;
    }
    visiting.add(identity);
    const p = closed(parse(row.fork_provenance_json), [
      'kind',
      'mode',
      'storeId',
      'commandId',
      'sourceSessionId',
      'sourceSelectionId',
      'sourceUpperSeq',
      'readonlySources',
      'extensionVersion',
      'ruleVersion',
      'sources',
    ]);
    if (
      p.kind !== 'fork_record' ||
      !['copy', 'rebuild'].includes(String(p.mode)) ||
      typeof p.commandId !== 'string' ||
      typeof p.sourceSessionId !== 'string' ||
      typeof p.sourceSelectionId !== 'string' ||
      typeof p.storeId !== 'string' ||
      typeof p.extensionVersion !== 'string' ||
      typeof p.ruleVersion !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(String(p.sourceUpperSeq)) ||
      BigInt(String(p.sourceUpperSeq)) > 9223372036854775807n ||
      !Array.isArray(p.sources) ||
      !p.sources.length ||
      p.sources.length > 64
    )
      return fail();
    if (p.mode === 'copy' && (p.sources.length !== 1 || object(p.sources[0]).key !== key))
      return fail();
    const source = session(db, p.sourceSessionId, input.subjectId);
    if (source.workspace_id !== current.workspace_id) return fail();
    const command = db.row(
      "SELECT * FROM command WHERE id=? AND session_id=? AND kind='session.create'",
      p.commandId,
      sessionId,
    );
    if (
      command?.status !== 'applied' ||
      command.subject_id !== input.subjectId ||
      command.origin_store_id !== p.storeId
    )
      return fail();
    const request = object(parse(command.request_json)),
      fork = object(request.fork),
      receipt = object(parse(command.receipt_json));
    if (
      fork.sourceSessionId !== p.sourceSessionId ||
      fork.expectedContextSelectionId !== p.sourceSelectionId ||
      receipt.sessionId !== sessionId ||
      receipt.sourceSessionId !== p.sourceSessionId ||
      receipt.sourceSelectionId !== p.sourceSelectionId ||
      receipt.sourceUpperSeq !== p.sourceUpperSeq ||
      !Array.isArray(receipt.namespaceReport) ||
      !receipt.namespaceReport.some((entry: unknown) => {
        const report = object(entry);
        return (
          report.extensionId === input.extensionId &&
          report.mode === p.mode &&
          report.ruleVersion === p.ruleVersion &&
          Number(p.mode === 'copy' ? report.copied : report.rebuilt) > 0
        );
      })
    )
      return fail();
    if (fork.boundary === null && p.sourceUpperSeq !== '0') return fail();
    if (
      fork.boundary &&
      typeof fork.boundary === 'object' &&
      object(fork.boundary).seq !== p.sourceUpperSeq
    )
      return fail();
    const snapshot = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND session_id=? AND kind='selection'",
      p.sourceSelectionId,
      p.sourceSessionId,
    );
    // Initial selectors have no context_snapshot row; the actual applied Fork receipt seals that identity.
    budget([
      identity,
      p,
      command.request_json,
      command.receipt_json,
      snapshot?.request_json ?? null,
    ]);
    proofs.push([
      identity,
      p,
      command.request_json,
      command.receipt_json,
      snapshot?.request_json ?? null,
    ]);
    const keys = new Set<string>();
    for (const value of p.sources) {
      const original = closed(value, ['key', 'revision', 'originStoreId', 'rawDigest']);
      if (
        typeof original.key !== 'string' ||
        !original.key ||
        original.key.length > 256 ||
        keys.has(original.key) ||
        typeof original.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(String(original.rawDigest))
      )
        return fail();
      keys.add(original.key);
      const originalRow = db.row(
        "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
        input.extensionId,
        p.sourceSessionId,
        original.key,
      );
      if (
        !originalRow ||
        String(originalRow.revision) !== original.revision ||
        originalRow.origin_store_id !== original.originStoreId ||
        textHash(String(originalRow.json)) !== original.rawDigest
      )
        return fail();
      walk(p.sourceSessionId, original.key, depth + 1);
    }
    visiting.delete(identity);
  }
  walk(input.sessionId, input.localKey, 0);
  const selection = selected(db, current),
    f = filter(selection, 'seq');
  const messages = db.rows(
    `SELECT * FROM message WHERE session_id=? AND status='complete' AND ${f.sql} AND ${historyOnlyCompression()} ORDER BY seq LIMIT 8193`,
    input.sessionId,
    ...f.args,
  );
  if (messages.length > 8192) throw new AgentError('dispatch_read_set_invalid');
  const origins = messages.map((message) => {
    const original = messageOriginRow(db, message, input.subjectId);
    if (!ancestorIds.has(String(original.session_id))) return fail();
    if (original.session_id !== input.sessionId) {
      const seq = BigInt(String(original.seq));
      for (const link of lineage) {
        if (seq > link.upper) return fail();
        if (
          link.selection &&
          !(
            seq > BigInt(link.selection.tailFromSeq) ||
            link.selection.ranges.some(
              (range) => seq > BigInt(range.afterSeq) && seq <= BigInt(range.throughSeq),
            )
          )
        )
          return fail();
        if (link.sessionId === original.session_id) break;
      }
    }

    const parts = db.rows(
      'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal LIMIT 8193',
      original.id!,
    );
    if (parts.length > 8192) throw new AgentError('dispatch_read_set_invalid');
    const projection = [
      String(message.id),
      String(message.seq),
      message.role,
      message.status,
      message.source_json,
      String(original.id),
      String(original.session_id),
      String(original.seq),
      original.source_json,
      parts.map((p) => [
        String(p.ordinal),
        p.kind,
        String(p.content_version),
        String(p.revision),
        p.json,
      ]),
    ];
    budget(projection);
    return projection;
  });
  const all = [...records.values()];
  if (Buffer.byteLength(canonicalJson(all as unknown as Json)) > 1024 * 1024)
    throw new AgentError('dispatch_read_set_invalid');
  return {
    binding: {
      version: 1,
      localKey: input.localKey,
      digest: hash([
        input.expectedStoreId,
        input.sessionId,
        String(current.workspace_id),
        input.subjectId,
        input.extensionId,
        selection,
        proofs,
        all,
        origins,
      ]),
    },
    records: all,
  };
}
export function readForkRecordSources(db: SqliteOperations, input: Input) {
  db.db.run('BEGIN');
  try {
    const result = forkRecordSources(db, input);
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
