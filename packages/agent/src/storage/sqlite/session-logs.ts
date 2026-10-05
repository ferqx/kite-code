import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { bodyReference, persistedModelRequest } from '../../model-body';
import { persistedModelRequestMetadata } from '../../model-snapshot';
import type { Store } from '../port';
import {
  AgentError,
  type Json,
  type SessionLogCategory,
  type SessionLogDetails,
  type SessionLogEntry,
  type SessionLogPage,
} from '../types';
import { verifyModelBody } from './model-body';
import { identity, sessionScope } from './model-input-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const statuses = new Set([
  'accepted',
  'applied',
  'rejected',
  'needs_review',
  'running',
  'waiting_interaction',
  'waiting_execution',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'planned',
  'dispatching',
  'succeeded',
  'outcome_unknown',
  'pending',
  'answered',
  'complete',
  'incomplete',
]);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9@][A-Za-z0-9_.:@/-]{0,127}$/.test(value);
const obj = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const category = (type: string): SessionLogCategory => {
  const prefix = type.split('.')[0];
  return [
    'command',
    'run',
    'execution',
    'interaction',
    'message',
    'context',
    'extension',
    'session',
  ].includes(prefix!)
    ? (prefix as SessionLogCategory)
    : prefix === 'action'
      ? 'execution'
      : 'other';
};
export function unwrapChangePayload(value: Json): Json {
  if (!obj(value) || value.format !== 'kite.session-log') return value;
  // A reserved wrapper is never public payload, even when a future or malformed metadata version is unreadable.
  return Object.hasOwn(value, 'payload') ? value.payload! : null;
}
function modelNavigation(db: SqliteOperations, sessionId: string, execution: Row): string | null {
  if (
    execution.kind !== 'model' ||
    !id(execution.id) ||
    execution.model_snapshot_json === null ||
    execution.run_id === null
  )
    return null;
  try {
    const command = db.row(
      'SELECT subject_id FROM command WHERE id=?',
      execution.origin_command_id!,
    );
    if (!command) return null;
    const session = sessionScope(db, {
      expectedStoreId: db.metadata().storeId,
      sessionId,
      subjectId: String(command.subject_id),
    });
    identity(
      db,
      { expectedStoreId: db.metadata().storeId, sessionId, subjectId: String(command.subject_id) },
      session,
      execution,
    );
    const input = JSON.parse(String(execution.intent_json)) as Json;
    const metadata = JSON.parse(String(execution.model_snapshot_json)) as Json;
    if (!obj(input) || input.requestId !== execution.id || input.modelId !== execution.adapter_id)
      return null;
    const sealed = bodyReference(input.body);
    if (sealed) {
      if (
        Object.keys(input).some(
          (key) => !['version', 'modelId', 'requestId', 'tools', 'body'].includes(key),
        ) ||
        !Array.isArray(input.tools) ||
        sealed.reference.mediaType !== 'application/json'
      )
        return null;
      verifyModelBody(db, input, execution);
    } else persistedModelRequest(input);
    if (obj(metadata) && bodyReference(metadata.body)) {
      if (
        Object.keys(metadata).sort().join(',') !== 'body,version' ||
        metadata.version !== 1 ||
        bodyReference(metadata.body)!.reference.mediaType !== 'application/json'
      )
        return null;
      verifyModelBody(db, metadata, execution);
    } else persistedModelRequestMetadata(metadata);
    return String(execution.id);
  } catch {
    return null;
  }
}
function modelProof(execution: Row): string {
  // Immutable private binding, not authorization and never a public log field.
  return createHash('sha256')
    .update(
      canonicalJson({
        storeId: execution.origin_store_id as string,
        sessionId: execution.session_id as string,
        runId: execution.run_id as string,
        commandId: execution.origin_command_id as string,
        rootSessionId: execution.root_session_id as string,
        rootWorkCommandId: execution.root_work_command_id as string,
        rootWorkSeq: String(execution.root_work_seq),
        attempt: String(execution.attempt),
        definitionId: execution.adapter_id as string,
        definitionVersion: execution.definition_version as string,
        input: String(execution.intent_json),
        metadata: String(execution.model_snapshot_json),
      }),
    )
    .digest('hex');
}
/** Trusted event owner captures only finite metadata, never the original payload as presentation. */
export function sessionLogEnvelope(
  db: SqliteOperations,
  session: string | null,
  objectId: string,
  type: string,
  payload: Json,
): Json {
  const details: SessionLogDetails = {};
  let status: string | null = null,
    modelExecutionId: string | null = null;
  const kind = category(type);
  let row: Row | null | undefined;
  if (session && (kind === 'execution' || type.startsWith('action.'))) {
    row = db.row('SELECT * FROM execution WHERE id=? AND session_id=?', objectId, session);
    if (row) {
      if (id(row.id)) details.executionId = row.id;
      if (id(row.run_id)) details.runId = row.run_id;
      if (id(row.origin_command_id)) details.commandId = row.origin_command_id;
      if (['model', 'tool', 'job'].includes(String(row.kind)))
        details.kind = row.kind as 'model' | 'tool' | 'job';
      if (name(row.adapter_id)) details.definitionId = row.adapter_id;
      if (name(row.definition_version)) details.definitionVersion = row.definition_version;
      if (Number.isSafeInteger(Number(row.attempt)) && Number(row.attempt) > 0)
        details.attempt = Number(row.attempt);
      status = statuses.has(String(row.state)) ? String(row.state) : null;
      modelExecutionId = modelNavigation(db, session, row);
    }
  } else if (session && ['command', 'run', 'interaction', 'message'].includes(kind)) {
    // Table names are closed Core record kinds, never caller SQL or extension payload.
    row = db.row(`SELECT * FROM ${kind} WHERE id=? AND session_id=?`, objectId, session);
    if (row) {
      status = statuses.has(String(row.status ?? row.state))
        ? String(row.status ?? row.state)
        : null;
      if (kind === 'command' && id(row.id)) details.commandId = row.id;
      if (kind === 'run' && id(row.id)) details.runId = row.id;
      if (kind === 'interaction' && id(row.id)) details.interactionId = row.id;
      if (id(row.run_id)) details.runId = row.run_id;
      if (id(row.execution_id)) details.executionId = row.execution_id;
    }
  }
  return {
    format: 'kite.session-log',
    version: 1,
    occurredAt: Date.now(),
    snapshot: {
      category: kind,
      recordedStatus: status,
      details: details as Json,
      modelExecutionId,
      modelInputDigest: modelExecutionId && row ? modelProof(row) : null,
    },
    payload,
  };
}
function cursor(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_cursor');
  return BigInt(value);
}
function decodeSnapshot(value: unknown): {
  category: SessionLogCategory;
  recordedStatus: string | null;
  details: SessionLogDetails;
  modelExecutionId: string | null;
  modelInputDigest: string | null;
} {
  if (
    !obj(value) ||
    Object.keys(value).sort().join(',') !==
      'category,details,modelExecutionId,modelInputDigest,recordedStatus' ||
    typeof value.category !== 'string' ||
    ![
      'command',
      'run',
      'execution',
      'interaction',
      'message',
      'context',
      'extension',
      'session',
      'other',
    ].includes(String(value.category)) ||
    (value.recordedStatus !== null &&
      (typeof value.recordedStatus !== 'string' || !statuses.has(value.recordedStatus))) ||
    !obj(value.details) ||
    (value.modelExecutionId !== null && !id(value.modelExecutionId)) ||
    (value.modelInputDigest !== null &&
      (typeof value.modelInputDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.modelInputDigest))) ||
    (value.modelExecutionId === null) !== (value.modelInputDigest === null)
  )
    throw new AgentError('session_log_metadata_invalid');
  for (const [key, item] of Object.entries(value.details)) {
    if (['commandId', 'runId', 'executionId', 'interactionId'].includes(key)) {
      if (!id(item)) throw new AgentError('session_log_metadata_invalid');
    } else if (['definitionId', 'definitionVersion'].includes(key)) {
      if (!name(item)) throw new AgentError('session_log_metadata_invalid');
    } else if (key === 'kind') {
      if (typeof item !== 'string' || !['model', 'tool', 'job'].includes(item))
        throw new AgentError('session_log_metadata_invalid');
    } else if (key === 'attempt') {
      if (!Number.isSafeInteger(item) || Number(item) < 1)
        throw new AgentError('session_log_metadata_invalid');
    } else throw new AgentError('session_log_metadata_invalid');
  }
  return value as unknown as ReturnType<typeof decodeSnapshot>;
}
export function getSessionLogs(
  db: SqliteOperations,
  input: Parameters<Store['getSessionLogs']>[0],
): SessionLogPage {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'expectedStoreId',
          'sessionId',
          'subjectId',
          'afterCursor',
          'upperCursor',
          'limit',
        ].includes(key),
    ) ||
    !id(input.sessionId) ||
    typeof input.subjectId !== 'string' ||
    input.subjectId.length < 1 ||
    input.subjectId.length > 256
  )
    throw new AgentError('session_log_scope_denied');
  const after = cursor(input.afterCursor);
  const count = input.limit ?? 200;
  if (!Number.isInteger(count) || count < 1 || count > 200)
    throw new AgentError('invalid_page_bounds');
  db.db.run('BEGIN');
  try {
    const meta = db.metadata();
    sessionScope(db, input);
    const upper =
      input.upperCursor === undefined ? BigInt(meta.lastChangeCursor) : cursor(input.upperCursor);
    if (after < BigInt(meta.replayFloor)) throw new AgentError('cursor_expired');
    if (after > upper || upper > BigInt(meta.lastChangeCursor))
      throw new AgentError('cursor_ahead');
    // Fetch only finite envelope fields; raw payload never crosses the read/Worker boundary.
    const rows = db.rows(
      `SELECT cursor,scope_session_id,object_id,revision,type,
      json_extract(payload_json,'$.format') AS format,json_extract(payload_json,'$.version') AS version,
      json_extract(payload_json,'$.occurredAt') AS occurred_at,json_extract(payload_json,'$.snapshot') AS snapshot,
      json_type(payload_json,'$.version') AS version_type,json_type(payload_json,'$.occurredAt') AS time_type,
      (SELECT COUNT(*) FROM json_each(payload_json)) AS key_count
      FROM change_event WHERE scope_session_id=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?`,
      input.sessionId,
      String(after),
      String(upper),
      count + 1,
    );
    const complete = rows.length <= count;
    const entries: SessionLogEntry[] = rows.slice(0, count).map((row) => {
      const type =
        typeof row.type === 'string' && /^[a-z][a-z0-9_.]{0,127}$/.test(row.type)
          ? row.type
          : 'unavailable';
      let occurredAt: number | null = null;
      let snapshot = {
        category: category(type),
        recordedStatus: null as string | null,
        details: {} as SessionLogDetails,
        modelExecutionId: null as string | null,
        modelInputDigest: null as string | null,
      };
      if (row.format === 'kite.session-log') {
        try {
          if (
            Number(row.version) !== 1 ||
            row.version_type !== 'integer' ||
            row.time_type !== 'integer' ||
            Number(row.key_count) !== 5 ||
            !Number.isSafeInteger(Number(row.occurred_at)) ||
            Number(row.occurred_at) < 0 ||
            typeof row.snapshot !== 'string' ||
            Buffer.byteLength(row.snapshot) > 4096
          )
            throw new AgentError('session_log_metadata_invalid');
          occurredAt = Number(row.occurred_at);
          snapshot = decodeSnapshot(JSON.parse(row.snapshot));
          if (snapshot.modelExecutionId) {
            const execution = db.row(
              'SELECT * FROM execution WHERE id=? AND session_id=?',
              snapshot.modelExecutionId,
              input.sessionId,
            );
            if (
              !execution ||
              modelNavigation(db, input.sessionId, execution) !== snapshot.modelExecutionId ||
              modelProof(execution) !== snapshot.modelInputDigest
            )
              snapshot.modelExecutionId = null;
          }
        } catch {
          occurredAt = null;
          snapshot = {
            category: category(type),
            recordedStatus: null,
            details: {},
            modelExecutionId: null,
            modelInputDigest: null,
          };
        }
      }
      const { modelInputDigest: _privateProof, ...publicSnapshot } = snapshot;
      return {
        cursor: String(row.cursor),
        sessionId: input.sessionId,
        objectId: id(row.object_id) ? row.object_id : 'unavailable',
        type,
        revision: String(row.revision),
        occurredAt,
        ...publicSnapshot,
        summary: `${type}${snapshot.recordedStatus ? `: ${snapshot.recordedStatus}` : occurredAt === null ? ': metadata unavailable' : ''}`,
      };
    });
    const result: SessionLogPage = {
      storeId: meta.storeId,
      sessionId: input.sessionId,
      upperCursor: String(upper),
      nextAfterCursor: complete ? null : entries.at(-1)!.cursor,
      replayFloor: meta.replayFloor,
      snapshotCursor: meta.lastChangeCursor,
      entries,
      complete,
    };
    if (Buffer.byteLength(canonicalJson(result as unknown as Json)) > 512 * 1024)
      throw new AgentError('session_log_page_too_large');
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
