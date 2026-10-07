import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { closePrivate as closeSync, openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';

const invalid = () => new MaintenanceError('backup_mcp_source_approval_intents_invalid');
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

/** Closed caller metadata. Matching hashes confer neither a receipt nor a POST permit. */
export function verifyMcpSourceApprovalRecords(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) throw invalid();
  const ids = new Set<string>();
  for (const raw of value) {
    const row = closed(raw, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
    const intent = closed(row.intent, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
    if (!id(intent.sessionId) || !id(intent.workspaceId) || !text(intent.workspaceIdentity, 4096))
      throw invalid();
    const request = closed(intent.request, [
      'expectedStoreId',
      'commandId',
      'kind',
      'extensionId',
      'actionId',
      'definitionVersion',
      'input',
    ]);
    if (
      !id(request.expectedStoreId) ||
      !id(request.commandId) ||
      request.kind !== 'extension.invoke' ||
      request.extensionId !== 'builtin.mcp.sources' ||
      request.actionId !== 'mcp.source.approve' ||
      request.definitionVersion !== '1'
    )
      throw invalid();
    const input = closed(request.input, ['serverId', 'expectedReadSet']);
    if (typeof input.serverId !== 'string' || !/^mcp-[a-f0-9]{64}$/.test(input.serverId))
      throw invalid();
    const readSet = closed(input.expectedReadSet, [
      'scopeDigest',
      'user',
      'workspace',
      'approvalEtag',
      'bindingEtag',
      'variablesDigest',
    ]);
    if (
      !hash(readSet.scopeDigest) ||
      !hash(readSet.variablesDigest) ||
      !nullableHash(readSet.approvalEtag) ||
      !nullableHash(readSet.bindingEtag)
    )
      throw invalid();
    const verifyRead = (value: unknown, kind: 'user' | 'workspace') => {
      const read = closed(value, ['identity', 'etag', 'error']);
      const identity = closed(read.identity, ['kind', 'pathDigest', 'rootIdentity']);
      if (
        identity.kind !== kind ||
        !hash(identity.pathDigest) ||
        !hash(identity.rootIdentity) ||
        !nullableHash(read.etag) ||
        (read.error !== null && typeof read.error !== 'string')
      )
        throw invalid();
    };
    verifyRead(readSet.user, 'user');
    if (readSet.workspace !== null) verifyRead(readSet.workspace, 'workspace');
    const { commandId, expectedStoreId: _store, ...publicRequest } = request;
    if (
      !text(row.subjectId, 256) ||
      row.bodySha256 !== sha(request) ||
      row.requestSha256 !== sha(publicRequest) ||
      typeof row.phase !== 'string' ||
      !['submitting', 'pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(
        row.phase as string,
      ) ||
      ids.has(commandId as string)
    )
      throw invalid();
    ids.add(commandId as string);
  }
}

export function verifyMcpSourceApprovalIntentsDocument(path: string): void {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      (process.platform !== 'win32' && (Number(before.mode) & 0o777) !== 0o600) ||
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
    verifyMcpSourceApprovalRecords(doc.records);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw invalid();
  } finally {
    closeSync(fd);
  }
}
