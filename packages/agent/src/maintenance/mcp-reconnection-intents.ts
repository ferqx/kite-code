import { createHash } from 'node:crypto';
import { closeSync, fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';

const invalid = () => new MaintenanceError('backup_mcp_reconnection_intents_invalid');
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nullableHash = (value: unknown) => value === null || hash(value);
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const sha = (value: Record<string, unknown>) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');

function readSet(value: unknown): void {
  const row = closed(value, [
    'scopeDigest',
    'user',
    'workspace',
    'approvalEtag',
    'bindingEtag',
    'variablesDigest',
  ]);
  if (
    !hash(row.scopeDigest) ||
    !hash(row.variablesDigest) ||
    !nullableHash(row.approvalEtag) ||
    !nullableHash(row.bindingEtag)
  )
    throw invalid();
  const read = (value: unknown, kind: 'user' | 'workspace') => {
    const row = closed(value, ['identity', 'etag', 'error']);
    const identity = closed(row.identity, ['kind', 'pathDigest', 'rootIdentity']);
    if (
      identity.kind !== kind ||
      !hash(identity.pathDigest) ||
      !hash(identity.rootIdentity) ||
      !nullableHash(row.etag) ||
      (row.error !== null && typeof row.error !== 'string')
    )
      throw invalid();
  };
  read(row.user, 'user');
  if (row.workspace !== null) read(row.workspace, 'workspace');
}
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function reconnectionInput(value: unknown, storeId: unknown): Record<string, unknown> {
  const input = closed(value, ['serverId', 'key', 'target', 'replacement']);
  if (!id(input.serverId) || !key(input.key)) throw invalid();
  const target = closed(input.target, [
    'carrierExecutionId',
    'carrierKey',
    'operationRef',
    'connectionExecutionId',
    'configDigest',
    'currentGeneration',
  ]);
  const operation = closed(target.operationRef, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !id(target.carrierExecutionId) ||
    !key(target.carrierKey) ||
    !id(target.connectionExecutionId) ||
    !hash(target.configDigest) ||
    !Number.isSafeInteger(target.currentGeneration) ||
    (target.currentGeneration as number) < 1 ||
    !id(operation.commandId) ||
    !id(operation.sessionId) ||
    operation.originStoreId !== storeId ||
    operation.extensionId !== 'builtin.mcp' ||
    typeof operation.key !== 'string' ||
    !operation.key.startsWith(`connection/${input.serverId}/`) ||
    !key(operation.key.slice(`connection/${input.serverId}/`.length)) ||
    !id(operation.executionId) ||
    operation.executionId !== target.connectionExecutionId ||
    input.key === target.carrierKey ||
    input.key === (operation.key as string).slice(`connection/${input.serverId}/`.length)
  )
    throw invalid();
  if (!input.replacement || typeof input.replacement !== 'object') throw invalid();
  const kind = (input.replacement as Record<string, unknown>).kind;
  const replacement = closed(
    input.replacement,
    kind === 'static'
      ? ['kind', 'expectedConfigDigest']
      : ['kind', 'expectedConfigDigest', 'expectedReadSet'],
  );
  if (!hash(replacement.expectedConfigDigest)) throw invalid();
  if (kind === 'source') readSet(replacement.expectedReadSet);
  else if (kind !== 'static') throw invalid();
  return input;
}
function request(value: unknown, target = false): Record<string, unknown> {
  const row = closed(value, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  if (
    !id(row.expectedStoreId) ||
    !id(row.commandId) ||
    row.kind !== 'extension.invoke' ||
    row.extensionId !== 'builtin.mcp' ||
    row.definitionVersion !== '1'
  )
    throw invalid();
  if (target && row.actionId === 'mcp.connect') {
    const input = closed(row.input, ['serverId', 'key']);
    if (!id(input.serverId) || !key(input.key)) throw invalid();
  } else {
    if (row.actionId !== 'mcp.reconnect') throw invalid();
    const input = reconnectionInput(row.input, row.expectedStoreId);
    const operation = (input.target as Record<string, unknown>).operationRef as Record<
      string,
      unknown
    >;
    if (row.commandId === operation.commandId) throw invalid();
  }
  return row;
}
/** Offline closed caller bytes only: neither a receipt nor restored permission to reconnect. */
export function verifyMcpReconnectionRecords(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) throw invalid();
  const ids = new Set<string>();
  for (const raw of value) {
    const row = closed(raw, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
    const intent = closed(row.intent, [
      'sessionId',
      'workspaceId',
      'workspaceIdentity',
      'targetRequest',
      'request',
    ]);
    if (!id(intent.sessionId) || !id(intent.workspaceId) || !text(intent.workspaceIdentity, 4096))
      throw invalid();
    const current = request(intent.request);
    const previous = request(intent.targetRequest, true);
    const input = current.input as Record<string, unknown>;
    const target = input.target as Record<string, unknown>;
    const previousInput = previous.input as Record<string, unknown>;
    const operation = target.operationRef as Record<string, unknown>;
    const previousOperation =
      previous.actionId === 'mcp.reconnect'
        ? ((previousInput.target as Record<string, unknown>).operationRef as Record<
            string,
            unknown
          >)
        : null;
    if (
      operation.sessionId !== intent.sessionId ||
      (previousOperation !== null && previousOperation.sessionId !== intent.sessionId) ||
      current.expectedStoreId !== previous.expectedStoreId ||
      input.serverId !== previousInput.serverId ||
      target.carrierKey !== previousInput.key ||
      current.commandId === previous.commandId
    )
      throw invalid();
    const { commandId, expectedStoreId: _store, ...publicRequest } = current;
    if (
      !text(row.subjectId, 256) ||
      row.bodySha256 !== sha(current) ||
      row.requestSha256 !== sha(publicRequest) ||
      typeof row.phase !== 'string' ||
      !['submitting', 'pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(
        row.phase,
      ) ||
      ids.has(commandId as string)
    )
      throw invalid();
    ids.add(commandId as string);
  }
}

export function verifyMcpReconnectionIntentsDocument(path: string): void {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.nlink !== 1n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 16n * 1024n * 1024n
    )
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) throw invalid();
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'uid', 'nlink'].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      throw invalid();
    const doc = closed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), [
      'version',
      'records',
    ]);
    if (doc.version !== 1) throw invalid();
    verifyMcpReconnectionRecords(doc.records);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw invalid();
  } finally {
    closeSync(fd);
  }
}
