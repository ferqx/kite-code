import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { DispatchInput } from '../port';
import { AgentError, type DispatchRecordRead, type ExtensionRecord, type Json } from '../types';
import {
  executionGuard,
  inheritsActionSource,
  readExecutionGroupSafety,
} from './execution-group-safety';
import { forkSourceProjection } from './fork-readonly-sources';
import { forkRecordSources } from './fork-record-sources';
import type { SqliteOperations } from './operations';

const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
export function dispatchRecordRead(
  extensionId: string,
  sessionId: string,
  key: string,
  record: ExtensionRecord | null,
): DispatchRecordRead {
  return {
    extensionId,
    sessionId,
    key,
    revision: record?.revision ?? null,
    originStoreId: record?.originStoreId ?? null,
    digest: digest(record),
  };
}
export function assertDispatchReadSet(
  db: SqliteOperations,
  execution: Record<string, string | number | bigint | null>,
  input: DispatchInput,
) {
  const value = JSON.parse(String(execution.decision_source_json));
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (inheritsActionSource(db, execution, source)) {
    if (input.readSet !== undefined) throw new AgentError('dispatch_read_set_invalid');
    return;
  }
  const original = source.recordReads;
  const originalLists = source.recordListReads;
  const originalForks = source.forkBindings;
  const originalSourceForks = source.forkSourceBindings;
  const guard = executionGuard(db, execution);
  if (
    original === undefined &&
    originalLists === undefined &&
    originalForks === undefined &&
    originalSourceForks === undefined &&
    !guard &&
    input.readSet === undefined
  )
    return;
  const set = input.readSet;
  if (
    !set ||
    Object.keys(set).some(
      (key) =>
        ![
          'records',
          'recordLists',
          'forkBindings',
          'forkSourceBindings',
          'executionGroup',
        ].includes(key),
    ) ||
    !Array.isArray(set.records) ||
    set.records.length > 64 ||
    Buffer.byteLength(canonicalJson(set.records as unknown as Json)) > 32 * 1024 ||
    canonicalJson((original ?? []) as Json) !== canonicalJson(set.records as unknown as Json)
  )
    throw new AgentError('dispatch_read_set_invalid');
  const forks = set.forkBindings ?? [];
  if (
    !Array.isArray(forks) ||
    forks.length > 64 ||
    canonicalJson((originalForks ?? []) as Json) !== canonicalJson(forks as unknown as Json) ||
    Buffer.byteLength(canonicalJson(set.records as unknown as Json)) +
      Buffer.byteLength(canonicalJson(forks as unknown as Json)) >
      32 * 1024
  )
    throw new AgentError('dispatch_read_set_invalid');
  const permitted = new Map<string, DispatchRecordRead>();
  const anchors = new Set<string>();
  const forkCommand = db.row(
    'SELECT subject_id FROM command WHERE id=? AND session_id=?',
    execution.origin_command_id!,
    execution.session_id!,
  );
  const sourceForks = set.forkSourceBindings ?? [];
  if (
    !Array.isArray(sourceForks) ||
    forks.length + sourceForks.length > 64 ||
    canonicalJson((originalSourceForks ?? []) as Json) !==
      canonicalJson(sourceForks as unknown as Json) ||
    Buffer.byteLength(
      canonicalJson([...set.records, ...forks, ...sourceForks] as unknown as Json),
    ) >
      32 * 1024
  )
    throw new AgentError('dispatch_read_set_invalid');
  const sourceAnchors = new Set<string>();
  for (const binding of sourceForks) {
    if (
      !binding ||
      Object.keys(binding).some((k) => !['version', 'localKey', 'digest'].includes(k)) ||
      binding.version !== 1 ||
      typeof binding.localKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(binding.digest) ||
      sourceAnchors.has(binding.localKey) ||
      !forkCommand
    )
      throw new AgentError('dispatch_read_set_invalid');
    sourceAnchors.add(binding.localKey);
    const actual = forkSourceProjection(db, {
      expectedStoreId: input.expectedStoreId,
      sessionId: String(execution.session_id),
      subjectId: String(forkCommand.subject_id),
      extensionId: String(source.extensionId),
      localKey: binding.localKey,
    });
    if (
      canonicalJson(actual.binding as unknown as Json) !== canonicalJson(binding as unknown as Json)
    )
      throw new AgentError('dispatch_read_set_changed');
  }
  for (const binding of forks) {
    if (
      !binding ||
      Object.keys(binding).some((key) => !['version', 'localKey', 'digest'].includes(key)) ||
      binding.version !== 1 ||
      typeof binding.localKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(binding.digest) ||
      anchors.has(binding.localKey) ||
      !forkCommand
    )
      throw new AgentError('dispatch_read_set_invalid');
    anchors.add(binding.localKey);
    const actual = forkRecordSources(db, {
      expectedStoreId: input.expectedStoreId,
      sessionId: String(execution.session_id),
      subjectId: String(forkCommand.subject_id),
      extensionId: String(source.extensionId),
      localKey: binding.localKey,
    });
    if (
      canonicalJson(actual.binding as unknown as Json) !== canonicalJson(binding as unknown as Json)
    )
      throw new AgentError('dispatch_read_set_changed');
    for (const record of actual.records) {
      permitted.set(
        canonicalJson([record.extensionId, record.sessionId, record.key]),
        dispatchRecordRead(record.extensionId, record.sessionId, record.key, record),
      );
      if (permitted.size > 64) throw new AgentError('dispatch_read_set_invalid');
    }
  }
  const seen = new Set<string>();
  for (const read of set.records) {
    const identity = read && canonicalJson([read.extensionId, read.sessionId, read.key]);
    if (
      !read ||
      Object.keys(read).some(
        (key) =>
          !['extensionId', 'sessionId', 'key', 'revision', 'originStoreId', 'digest'].includes(key),
      ) ||
      (read.sessionId !== execution.session_id && !permitted.has(identity)) ||
      read.extensionId !== source.extensionId ||
      typeof read.key !== 'string' ||
      !read.key ||
      read.key.length > 256 ||
      !/^[a-f0-9]{64}$/.test(read.digest) ||
      seen.has(identity)
    )
      throw new AgentError('dispatch_read_set_invalid');
    seen.add(identity);
    const row = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      read.extensionId,
      read.sessionId,
      read.key,
    );
    const record: ExtensionRecord | null = row
      ? {
          extensionId: String(row.extension_id),
          sessionId: String(row.scope_id),
          key: String(row.key),
          revision: String(row.revision),
          originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
          contentType: String(row.content_type),
          contentVersion: Number(row.content_version),
          value: JSON.parse(String(row.json)),
          forkProvenance:
            row.fork_provenance_json === null ? null : JSON.parse(String(row.fork_provenance_json)),
        }
      : null;
    if (
      canonicalJson(
        dispatchRecordRead(read.extensionId, read.sessionId, read.key, record) as unknown as Json,
      ) !== canonicalJson(read as unknown as Json)
    )
      throw new AgentError('dispatch_read_set_changed');
  }
  for (const [identity, read] of permitted) {
    if (
      !seen.has(identity) ||
      !set.records.some(
        (item) => canonicalJson(item as unknown as Json) === canonicalJson(read as unknown as Json),
      )
    )
      throw new AgentError('dispatch_read_set_invalid');
  }
  const lists = set.recordLists ?? [];
  if (
    !Array.isArray(lists) ||
    lists.length > 64 ||
    Buffer.byteLength(canonicalJson(lists as unknown as Json)) > 32 * 1024 ||
    canonicalJson((originalLists ?? []) as Json) !== canonicalJson(lists as unknown as Json)
  )
    throw new AgentError('dispatch_read_set_invalid');
  const listKeys = new Set<string>();
  for (const read of lists) {
    if (
      !read ||
      Object.keys(read).some(
        (key) =>
          !['extensionId', 'sessionId', 'afterKey', 'limit', 'contentType', 'digest'].includes(key),
      ) ||
      read.extensionId !== source.extensionId ||
      read.sessionId !== execution.session_id ||
      typeof read.afterKey !== 'string' ||
      read.afterKey.length > 256 ||
      !Number.isInteger(read.limit) ||
      read.limit < 1 ||
      read.limit > 200 ||
      (read.contentType !== null && typeof read.contentType !== 'string') ||
      !/^[a-f0-9]{64}$/.test(read.digest)
    )
      throw new AgentError('dispatch_read_set_invalid');
    const key = JSON.stringify([
      read.extensionId,
      read.sessionId,
      read.afterKey,
      read.limit,
      read.contentType,
    ]);
    if (listKeys.has(key)) throw new AgentError('dispatch_read_set_invalid');
    listKeys.add(key);
    const rows = db.rows(
      `SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>?${read.contentType ? ' AND content_type=?' : ''} ORDER BY key LIMIT ?`,
      read.extensionId,
      read.sessionId,
      read.afterKey,
      ...(read.contentType ? [read.contentType] : []),
      read.limit,
    );
    const records = rows.map((row) => ({
      extensionId: String(row.extension_id),
      sessionId: String(row.scope_id),
      key: String(row.key),
      revision: String(row.revision),
      originStoreId: row.origin_store_id === null ? null : String(row.origin_store_id),
      contentType: String(row.content_type),
      contentVersion: Number(row.content_version),
      value: JSON.parse(String(row.json)),
      forkProvenance:
        row.fork_provenance_json === null ? null : JSON.parse(String(row.fork_provenance_json)),
    }));
    if (digest(records) !== read.digest) throw new AgentError('dispatch_read_set_changed');
  }
  if (!guard) {
    if (set.executionGroup !== undefined) throw new AgentError('dispatch_read_set_invalid');
    return;
  }
  const group = set.executionGroup;
  const contextRevision = source.contextRevision;
  if (
    !group ||
    Object.keys(group).some(
      (key) =>
        !['rootSessionId', 'executionId', 'revision', 'contextRevision', 'quiescent'].includes(key),
    ) ||
    group.executionId !== execution.id ||
    group.rootSessionId !== guard.rootSessionId ||
    group.quiescent !== true ||
    group.contextRevision !== contextRevision ||
    (contextRevision !== undefined &&
      (typeof contextRevision !== 'string' || !/^[a-f0-9]{64}$/.test(contextRevision)))
  )
    throw new AgentError('dispatch_read_set_invalid');
  const command = db.row('SELECT subject_id FROM command WHERE id=?', execution.origin_command_id!);
  const actual = readExecutionGroupSafety(db, {
    expectedStoreId: input.expectedStoreId,
    sessionId: String(execution.session_id),
    subjectId: String(command?.subject_id),
    boundaryCommandId: String(execution.origin_command_id),
    excludeExecutionId: String(execution.id),
  });
  if (!actual.quiescent || actual.revision !== group.revision)
    throw new AgentError('execution_group_not_quiescent');
  if (contextRevision !== undefined && actual.contextRevision !== contextRevision)
    throw new AgentError('dispatch_read_set_changed');
}
