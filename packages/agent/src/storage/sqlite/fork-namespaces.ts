import { createHash } from 'node:crypto';
import { recordValidator } from '../../extensions/fork';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ForkNamespacePlan, type Json } from '../types';
import { historyOnlyCompression } from './compression-operations';
import { filter, pairBoundary, selected } from './context-selection-operations';
import { readExecutionGroupSafety } from './execution-group-safety';
import { assertReadonlyProof } from './fork-readonly-sources';
import type { SqliteOperations } from './operations';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Input = Parameters<Store['readForkNamespacePage']>[0];
export function namespaceSource(db: SqliteOperations, input: Input) {
  db.identity(input.expectedStoreId);
  const source = db.row('SELECT * FROM session WHERE id=?', input.sourceSessionId);
  if (!source || source.delete_requested) throw new AgentError('session_not_found');
  if (source.parent_id !== null) throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    source.id!,
  );
  if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  if (source.context_selection_id !== input.expectedContextSelectionId)
    throw new AgentError('context_selection_changed');
  if (
    db.row(
      'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1',
      source.id!,
    ) ||
    db.row(
      "SELECT id FROM execution WHERE root_session_id=? AND state IN('planned','dispatching','running','outcome_unknown')",
      source.id!,
    )
  )
    throw new AgentError('context_execution_unsettled');
  const selection = selected(db, source),
    f = filter(selection, 'seq');
  let upper = String(source.next_seq);
  if (input.boundary === null) upper = '0';
  else if (input.boundary !== undefined) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(input.boundary.seq) ||
      BigInt(input.boundary.seq) > 9223372036854775807n
    )
      throw new AgentError('invalid_context_cursor');
    if (
      !db.row(
        `SELECT id FROM message WHERE id=? AND session_id=? AND seq=? AND status='complete' AND ${f.sql} AND ${historyOnlyCompression()}`,
        input.boundary.messageId,
        source.id!,
        input.boundary.seq,
        ...f.args,
      )
    )
      throw new AgentError('context_boundary_invalid');
    upper = input.boundary.seq;
  }
  pairBoundary(db, String(source.id), selection, upper);
  const messages = db
    .rows(
      `SELECT id,seq,source_json FROM message WHERE session_id=? AND seq<=? AND ${f.sql} AND ${historyOnlyCompression()} ORDER BY seq`,
      source.id!,
      upper,
      ...f.args,
    )
    .map((row) => {
      const value = JSON.parse(String(row.source_json)) as { sourceIds?: string[] };
      return { id: String(row.id), seq: String(row.seq), sourceIds: value.sourceIds ?? [] };
    });
  return { source, upper, messages };
}
export function readForkNamespacePage(db: SqliteOperations, input: Input) {
  db.db.run('BEGIN');
  try {
    const source = namespaceSource(db, input),
      snapshotCursor = db.metadata().lastChangeCursor,
      dataVersion = String(db.row('PRAGMA data_version')!.data_version);
    if (
      (input.expectedSnapshotCursor !== undefined &&
        input.expectedSnapshotCursor !== snapshotCursor) ||
      (input.expectedDataVersion !== undefined && input.expectedDataVersion !== dataVersion)
    )
      throw new AgentError('fork_namespace_changed');
    const after = input.afterSeq ?? '0';
    if (!/^(0|[1-9][0-9]*)$/.test(after) || BigInt(after) > 9223372036854775807n)
      throw new AgentError('invalid_context_cursor');
    const rows = db.rows(
      "SELECT *,CAST(rowid AS TEXT) AS source_seq FROM extension_record WHERE scope_kind='session' AND scope_id=? AND rowid>? ORDER BY rowid LIMIT 201",
      input.sourceSessionId,
      after,
    );
    const result = {
      snapshotCursor,
      dataVersion,
      sourceUpperSeq: source.upper,
      selectedMessages: source.messages,
      records: rows.slice(0, 200).map((row) => ({
        seq: String(row.source_seq),
        extensionId: String(row.extension_id),
        key: String(row.key),
        revision: String(row.revision),
        contentType: String(row.content_type),
        contentVersion: Number(row.content_version),
        originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
        rawDigest: hash(String(row.json)),
        rawText: Buffer.byteLength(String(row.json)) <= 1024 * 1024 ? String(row.json) : null,
        forkProvenance:
          row.fork_provenance_json === null
            ? null
            : (JSON.parse(String(row.fork_provenance_json)) as Json),
      })),
      nextAfterSeq: rows.length > 200 ? String(rows[199]!.source_seq) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw new AgentError('fork_namespace_too_large');
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
/** Compile trusted closed output schemas before the write transaction. No callback runs in SQL. */
export function validateNamespacePlan(plan: ForkNamespacePlan | undefined) {
  if (!plan) return;
  if (Buffer.byteLength(JSON.stringify(plan)) > 1024 * 1024)
    throw new AgentError('fork_namespace_too_large');
  const keys = new Set<string>();
  for (const write of plan.writes) {
    const key = `${write.extensionId}\0${write.key}`;
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/.test(write.extensionId) ||
      typeof write.key !== 'string' ||
      !write.key ||
      write.key.length > 256 ||
      keys.has(key) ||
      !['copy', 'rebuild'].includes(write.mode) ||
      !write.ruleVersion ||
      !write.extensionVersion ||
      !Number.isSafeInteger(write.contentVersion) ||
      write.contentVersion < 1 ||
      !recordValidator(write.schema)(JSON.parse(write.rawText))
    )
      throw new AgentError('fork_namespace_invalid');
    keys.add(key);
  }
}
export function applyNamespacePlan(
  db: SqliteOperations,
  input: Parameters<Store['forkSession']>[0],
  upper: string,
) {
  const plan = input.namespacePlan;
  if (!plan) return;
  if (
    plan.snapshotCursor !== db.metadata().lastChangeCursor ||
    plan.dataVersion !== String(db.row('PRAGMA data_version')!.data_version) ||
    plan.sourceUpperSeq !== upper
  )
    throw new AgentError('fork_namespace_changed');
  const source = namespaceSource(db, input);
  if (plan.selectedMessagesDigest !== hash(canonicalJson(source.messages as unknown as Json)))
    throw new AgentError('fork_namespace_changed');
  const rows = db.rows(
    "SELECT *,CAST(rowid AS TEXT) AS source_seq FROM extension_record WHERE scope_kind='session' AND scope_id=? ORDER BY rowid",
    input.sourceSessionId,
  );
  const actual = rows.map((row) => ({
    seq: String(row.source_seq),
    extensionId: String(row.extension_id),
    key: String(row.key),
    revision: String(row.revision),
    contentType: String(row.content_type),
    contentVersion: Number(row.content_version),
    originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
    rawDigest: hash(String(row.json)),
    forkProvenance:
      row.fork_provenance_json === null
        ? null
        : (JSON.parse(String(row.fork_provenance_json)) as Json),
  }));
  if (canonicalJson(actual as unknown as Json) !== canonicalJson(plan.sources as unknown as Json))
    throw new AgentError('fork_namespace_changed');
  for (const write of plan.writes) {
    const originals = rows.filter(
      (row) => row.extension_id === write.extensionId && write.sourceKeys.includes(String(row.key)),
    );
    if (write.sourceKeys.length !== originals.length)
      throw new AgentError('fork_namespace_invalid');
    if (
      write.mode === 'copy' &&
      (originals.length !== 1 ||
        originals[0]!.key !== write.key ||
        originals[0]!.json !== write.rawText ||
        originals[0]!.content_type !== write.contentType ||
        Number(originals[0]!.content_version) !== write.contentVersion)
    )
      throw new AgentError('fork_namespace_invalid');
    if (write.readonlyProof) {
      if (write.mode !== 'rebuild') throw new AgentError('fork_namespace_invalid');
      const scope = {
        expectedStoreId: input.expectedStoreId,
        subjectId: input.subjectId,
        sessionId: input.sourceSessionId,
        extensionId: write.extensionId,
      };
      if (!readExecutionGroupSafety(db, scope).quiescent)
        throw new AgentError('execution_group_not_quiescent');
      assertReadonlyProof(db, scope, write.readonlyProof);
    }
    const origin = write.mode === 'copy' ? originals[0]!.origin_store_id : null;
    const provenance = {
      ...(write.readonlyProof ? { readonlySources: write.readonlyProof } : {}),
      kind: 'fork_record',
      mode: write.mode,
      storeId: input.expectedStoreId,
      commandId: input.commandId,
      sourceSessionId: input.sourceSessionId,
      sourceSelectionId: input.expectedContextSelectionId,
      sourceUpperSeq: upper,
      extensionVersion: write.extensionVersion,
      ruleVersion: write.ruleVersion,
      sources: originals.map((row) => ({
        key: String(row.key),
        revision: String(row.revision),
        originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
        rawDigest: hash(String(row.json)),
      })),
    };
    db.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json,fork_provenance_json) VALUES(?,'session',?,?,1,?,?,?,?,?)",
      write.extensionId,
      input.newSessionId,
      write.key,
      write.contentType,
      write.contentVersion,
      origin!,
      write.rawText,
      canonicalJson(provenance as unknown as Json),
    );
  }
}
