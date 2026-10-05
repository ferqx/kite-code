import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import {
  AgentError,
  type Json,
  type SessionExportManifest,
  type SessionExportSection,
} from '../types';
import type { SqliteOperations } from './operations';

type Scope = { expectedStoreId: string; sessionId: string; subjectId: string };
type Descriptor = {
  table: string;
  scope: string;
  session: string;
  id: string;
  columns: readonly string[];
};
/** Explicit export columns; operational leases, configured credentials and host private state are excluded. */
const descriptors: Record<SessionExportSection, Descriptor> = {
  sessions: {
    table: 'session t',
    scope: 't.root_id=?',
    session: 't.id',
    id: 't.id',
    columns: [
      'id',
      'workspace_id',
      'parent_id',
      'root_id',
      'title',
      'control_revision',
      'next_seq',
      'context_selection_id',
      'delete_requested',
      'deleted_at',
      'stop_boundary',
    ],
  },
  commands: {
    table: 'command t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'session_id',
      'seq',
      'kind',
      'subject_id',
      'request_digest',
      'request_json',
      'status',
      'receipt_json',
      'origin_store_id',
      'root_work_command_id',
      'root_work_seq',
      'cancelled',
      'cancel_requested_at',
      'extension_id',
      'scope_kind',
      'scope_id',
      'operation_key',
      'target_command_id',
      'agent_source_execution_id',
      'agent_carrier_execution_id',
      'input_target_run_id',
      'input_context_selection_id',
      'after_run_id',
      'mail_target_session_id',
      'mail_target_run_id',
      'mail_selection_id',
      'mail_received_message_id',
      'mail_received_run_id',
      'mail_received_selection_id',
      'mail_adoption_upper_seq',
      'mail_adoption_cursor',
      'mail_confirmed',
    ],
  },
  runs: {
    table: 'run t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'session_id',
      'origin_command_id',
      'origin_store_id',
      'root_work_command_id',
      'root_work_seq',
      'status',
      'is_active',
      'requirements_json',
      'context_selection_id',
      'initialization_state',
      'waiting_results_json',
      'started_at',
      'deadline_at',
      'finished_at',
      'reason',
      'cancel_requested_at',
      'cancel_requested',
    ],
  },
  messages: {
    table: 'message t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'session_id',
      'run_id',
      'seq',
      'role',
      'status',
      'source_json',
      'fork_source_message_id',
    ],
  },
  message_parts: {
    table: 'message_part t JOIN message m ON m.id=t.message_id',
    scope: 'm.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 'm.session_id',
    id: 't.message_id',
    columns: ['message_id', 'ordinal', 'kind', 'content_version', 'revision', 'json'],
  },
  executions: {
    table: 'execution t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'session_id',
      'run_id',
      'kind',
      'origin_command_id',
      'origin_store_id',
      'root_work_command_id',
      'root_work_seq',
      'parent_execution_id',
      'cancel_with_parent',
      'root_session_id',
      'step_id',
      'call_id',
      'attempt',
      'adapter_id',
      'definition_version',
      'child_session_id',
      'after_turn_json',
      'state',
      'intent_json',
      'decision_source_json',
      'model_snapshot_json',
      'dispatch_authorization_json',
      'result_json',
      'reference_json',
      'output_seq',
      'output_bytes',
      'output_truncated',
      'output_budget_exhausted',
      'interaction_binding_json',
      'predecessor_execution_id',
      'dispatched',
      'result_revision',
      'completed_cursor',
      'cancel_requested_at',
      'cancel_requested',
      'requirements_json',
      'delivery',
      'delivery_reason',
      'delivery_target_session_id',
      'context_selection_id',
    ],
  },
  execution_output: {
    table: 'execution_output t JOIN execution e ON e.id=t.execution_id',
    scope: 'e.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 'e.session_id',
    id: 't.execution_id',
    columns: [
      'execution_id',
      'stream',
      'seq',
      'blob_hash',
      'summary',
      'content',
      'through_seq',
      'dropped_bytes',
      'is_gap',
    ],
  },
  interactions: {
    table: 'interaction t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'origin_store_id',
      'subject_id',
      'session_id',
      'run_id',
      'execution_id',
      'attempt',
      'presentation_session_id',
      'ancestry_json',
      'kind',
      'definition_id',
      'definition_version',
      'input_digest',
      'policy_revision',
      'required_refs_json',
      'source_json',
      'request_digest',
      'request_json',
      'answer_json',
      'revision',
      'accepted_decision_revision',
      'state',
    ],
  },
  context_snapshots: {
    table: 'context_snapshot t',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'kind',
      'seq',
      'execution_id',
      'result_revision',
      'inclusion',
      'origin_store_id',
      'subject_id',
      'id',
      'session_id',
      'run_id',
      'step_id',
      'selection_id',
      'sources_json',
      'request_json',
    ],
  },
  extension_records: {
    table: 'extension_record t',
    scope: "t.scope_kind='session' AND t.scope_id IN (SELECT id FROM session WHERE root_id=?)",
    session: 't.scope_id',
    id: 't.key',
    columns: [
      'extension_id',
      'scope_kind',
      'scope_id',
      'key',
      'revision',
      'content_type',
      'content_version',
      'origin_store_id',
      'fork_provenance_json',
      'json',
    ],
  },
  artifact_refs: {
    table: 'blob_ref t JOIN blob b ON b.hash=t.blob_hash',
    scope: 't.session_id IN (SELECT id FROM session WHERE root_id=?)',
    session: 't.session_id',
    id: 't.id',
    columns: [
      'id',
      'blob_hash',
      'session_id',
      'owner_kind',
      'owner_id',
      'subject_id',
      'origin_store_id',
      'media_type',
    ],
  },
};
const instances = new WeakMap<SqliteOperations, string>();
function instance(db: SqliteOperations) {
  let id = instances.get(db);
  if (!id) {
    id = randomUUID();
    instances.set(db, id);
  }
  return id;
}
function decimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('export_invalid_page');
  return value;
}
function scope(db: SqliteOperations, input: Scope) {
  db.identity(input.expectedStoreId);
  const root = db.row('SELECT id,root_id,parent_id FROM session WHERE id=?', input.sessionId);
  if (!root) throw new AgentError('session_not_found');
  if (root.parent_id !== null || root.root_id !== root.id)
    throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT subject_id,origin_store_id FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (!creator || creator.subject_id !== input.subjectId)
    throw new AgentError('export_scope_denied');
  // Every descendant must have actual sealed child.start ancestry, never an ID supplied by a renderer.
  const invalid = db.row(
    `SELECT s.id FROM session s WHERE s.root_id=? AND s.id<>? AND (s.parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM session p JOIN command c ON c.session_id=s.id AND c.kind='child.start' JOIN execution e ON e.id=json_extract(c.request_json,'$.parentExecutionId') JOIN command o ON o.id=e.origin_command_id WHERE p.id=s.parent_id AND p.root_id=s.root_id AND e.child_session_id=s.id AND e.session_id=p.id AND e.root_session_id=s.root_id AND c.subject_id=? AND o.subject_id=c.subject_id AND c.origin_store_id=e.origin_store_id AND o.origin_store_id=e.origin_store_id AND c.root_work_command_id=e.root_work_command_id AND c.root_work_seq=e.root_work_seq)) LIMIT 1`,
    input.sessionId,
    input.sessionId,
    input.subjectId,
  );
  if (invalid) throw new AgentError('export_scope_denied');
}
function manifest(db: SqliteOperations, input: Scope): SessionExportManifest {
  scope(db, input);
  return {
    version: 1,
    storeId: input.expectedStoreId,
    rootSessionId: input.sessionId,
    readInstanceId: instance(db),
    snapshotCursor: db.metadata().lastChangeCursor,
    dataVersion: String(db.row('PRAGMA data_version')!.data_version),
    sections: (Object.keys(descriptors) as SessionExportSection[]).map((section) => {
      const d = descriptors[section];
      const r = db.row(
        `SELECT CAST(COALESCE(MAX(t.rowid),0) AS TEXT) AS high,CAST(COUNT(*) AS TEXT) AS count FROM ${d.table} WHERE ${d.scope}`,
        input.sessionId,
      )!;
      return { section, highWaterSeq: String(r.high), count: String(r.count) };
    }),
    excluded: [
      'owner_and_lock_authority',
      'run_configuration_private_body',
      'child_configuration_private_body',
      'host_controls_and_credentials',
      'permission_grants',
      'profile_and_workspace_private_configuration',
    ],
    contentMedia: 'sqlite-records-and-original-scope-artifact-references',
  };
}
function read<T>(db: SqliteOperations, fn: () => T): T {
  db.db.run('BEGIN');
  try {
    const value = fn();
    db.db.run('COMMIT');
    return value;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
function verify(db: SqliteOperations, input: Scope, expected: SessionExportManifest) {
  const actual = manifest(db, input);
  if (canonicalJson(actual as unknown as Json) !== canonicalJson(expected as unknown as Json))
    throw new AgentError('export_changed');
  return actual;
}
export function callSessionExport(
  db: SqliteOperations,
  method:
    | 'beginSessionExport'
    | 'readSessionExportPage'
    | 'verifySessionExport'
    | 'readSessionExportText',
  input: Parameters<Store['readSessionExportPage']>[0],
) {
  return read(db, () => {
    if (method === 'beginSessionExport') return manifest(db, input);
    const current = verify(db, input, input.manifest);
    if (method === 'verifySessionExport')
      return { manifest: current, verified: true, contentMedia: current.contentMedia };
    const d = Object.hasOwn(descriptors, input.section) ? descriptors[input.section] : undefined;
    if (!d) throw new AgentError('export_invalid_page');
    if (method === 'readSessionExportText') {
      const textInput = input as unknown as Parameters<Store['readSessionExportText']>[0];
      if (!d.columns.includes(textInput.field)) throw new AgentError('export_invalid_page');
      const seq = decimal(textInput.seq),
        afterByte = decimal(textInput.afterByte ?? '0');
      const limitBytes = textInput.limitBytes ?? 65536;
      if (!Number.isInteger(limitBytes) || limitBytes < 1 || limitBytes > 65536)
        throw new AgentError('export_invalid_page');
      const upper = current.sections.find((s) => s.section === input.section)!.highWaterSeq;
      if (BigInt(seq) > BigInt(upper) || seq === '0') throw new AgentError('export_invalid_page');
      const row = db.db
        .query(
          `SELECT typeof(t.${textInput.field}) AS value_type,length(CAST(t.${textInput.field} AS BLOB)) AS bytes,substr(CAST(t.${textInput.field} AS BLOB),?,?) AS chunk FROM ${d.table} WHERE ${d.scope} AND t.rowid=?`,
        )
        .get(BigInt(afterByte) + 1n, limitBytes, input.sessionId, seq) as {
        value_type: string;
        bytes: bigint;
        chunk: Uint8Array;
      } | null;
      if (row?.value_type !== 'text' || BigInt(afterByte) > BigInt(row.bytes))
        throw new AgentError('export_invalid_page');
      const next = BigInt(afterByte) + BigInt(row.chunk.byteLength);
      return {
        storeId: current.storeId,
        rootSessionId: current.rootSessionId,
        section: input.section,
        seq,
        field: textInput.field,
        afterByte,
        byteLength: String(row.bytes),
        contentBase64: Buffer.from(row.chunk).toString('base64'),
        nextAfterByte: next < BigInt(row.bytes) ? String(next) : null,
      };
    }
    const limit = input.limit ?? 200,
      byteLimit = input.byteLimit ?? 1024 * 1024;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(byteLimit) ||
      byteLimit < 1024 ||
      byteLimit > 8 * 1024 * 1024
    )
      throw new AgentError('export_invalid_page');
    const after = decimal(input.afterSeq ?? '0'),
      upper = current.sections.find((s) => s.section === input.section)!.highWaterSeq;
    if (BigInt(after) > BigInt(upper)) throw new AgentError('export_invalid_page');
    const rows = db.rows(
      `SELECT CAST(t.rowid AS TEXT) AS export_seq,${d.session} AS export_session,${d.id} AS export_id,${d.columns.map((c) => `t.${c}`).join(',')}${input.section === 'artifact_refs' ? ',CAST(b.size AS TEXT) AS blob_size' : ''} FROM ${d.table} WHERE ${d.scope} AND t.rowid>? AND t.rowid<=? ORDER BY t.rowid LIMIT ?`,
      input.sessionId,
      after,
      upper,
      limit + 1,
    );
    const records = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const data: Record<string, Json> = {};
      for (const column of d.columns) {
        const value = row[column];
        data[column] =
          typeof value === 'string' && Buffer.byteLength(value) > 65536
            ? {
                kind: 'export_text',
                field: column,
                byteLength: String(Buffer.byteLength(value)),
                sha256: createHash('sha256').update(value).digest('hex'),
              }
            : typeof value === 'bigint'
              ? String(value)
              : (value ?? null);
      }
      if (input.section === 'artifact_refs') data.blob_size = String(row.blob_size);
      const record = {
        section: input.section,
        seq: String(row.export_seq),
        sessionId: String(row.export_session),
        id: String(row.export_id),
        record: data,
      };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (bytes + size > byteLimit) {
        if (!records.length) throw new AgentError('export_record_too_large');
        break;
      }
      bytes += size;
      records.push(record);
    }
    const nextAfterSeq = records.length < rows.length ? (records.at(-1)?.seq ?? null) : null;
    return {
      storeId: current.storeId,
      rootSessionId: current.rootSessionId,
      section: input.section,
      snapshotCursor: current.snapshotCursor,
      upperSeq: upper,
      records,
      nextAfterSeq,
    };
  });
}
